import { mkdirSync, writeFileSync, lstatSync, realpathSync, renameSync, openSync, writeSync, closeSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { join, resolve, normalize, relative, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import * as tierA from './templates/tier-a-npm-pack-no-build-v1.mjs';

const TEMPLATES = new Map([
  [tierA.TEMPLATE_ID, tierA],
]);

const ALLOWED_BASE = 'recipes/output/fullsend';
const FIXED_FILENAMES = ['manifest.json', 'build.entrypoint.sh', 'verify.smoke.sh', 'evidence.md'];
const MAX_PARAM_VALUE_LENGTH = 2000;
const MAX_TOTAL_OUTPUT_BYTES = 1024 * 1024;

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const PATH_TRAVERSAL_RE = /\.\./;
const ABSOLUTE_PATH_RE = /^[/\\]/;
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+([-+][-a-zA-Z0-9.+]+)?$/;

export function render(recipeResult, repoRoot) {
  const errors = [];

  if (!recipeResult || typeof recipeResult !== 'object') {
    throw new RenderError('recipe result must be an object');
  }
  if (recipeResult.status !== 'drafted') {
    throw new RenderError('only drafted results can be rendered');
  }

  const templateId = recipeResult.template_id;
  const template = TEMPLATES.get(templateId);
  if (!template) {
    throw new RenderError(`unsupported template_id: ${templateId}. Allowed: ${[...TEMPLATES.keys()].join(', ')}`);
  }

  const params = recipeResult.parameters;
  if (!params || typeof params !== 'object') {
    throw new RenderError('parameters must be an object');
  }

  validateParameters(params, template.PARAM_SPEC, errors);
  if (errors.length > 0) {
    throw new RenderError(`parameter validation failed: ${errors.map(e => e.message).join('; ')}`);
  }

  const pkgName = params.package_name.value;
  const pkgVersion = params.package_version.value;
  validateIdentityFields(pkgName, pkgVersion, errors);
  if (errors.length > 0) {
    throw new RenderError(`identity validation failed: ${errors.map(e => e.message).join('; ')}`);
  }

  const absBase = resolve(repoRoot, ALLOWED_BASE);
  const outputDir = join(absBase, pkgName, pkgVersion);

  validateOutputPath(outputDir, absBase, errors);
  if (errors.length > 0) {
    throw new RenderError(`output path validation failed: ${errors.map(e => e.message).join('; ')}`);
  }

  const files = new Map();
  files.set('manifest.json', template.generateManifest(params));
  files.set('build.entrypoint.sh', template.generateBuildEntrypoint(params));
  files.set('verify.smoke.sh', template.generateVerifySmoke(params));
  files.set('evidence.md', template.generateEvidence(
    params,
    recipeResult.evidence,
    recipeResult.could_not_verify,
  ));

  validateGeneratedContent(files, errors);
  if (errors.length > 0) {
    throw new RenderError(`content validation failed: ${errors.map(e => e.message).join('; ')}`);
  }

  const normalizedPaths = new Set();
  for (const filename of files.keys()) {
    if (!FIXED_FILENAMES.includes(filename)) {
      throw new RenderError(`unexpected output filename: ${filename}`);
    }
    const norm = normalize(join(outputDir, filename));
    if (normalizedPaths.has(norm)) {
      throw new RenderError(`duplicate normalised path: ${norm}`);
    }
    normalizedPaths.add(norm);
  }

  writeAtomically(outputDir, files, absBase);

  return {
    output_dir: outputDir,
    files: [...files.keys()],
    template_id: templateId,
  };
}

function validateParameters(params, spec, errors) {
  const knownKeys = new Set(Object.keys(spec));
  for (const key of Object.keys(params)) {
    if (!knownKeys.has(key)) {
      errors.push({ path: `/parameters/${key}`, message: `unknown parameter: ${key}` });
    }
  }

  for (const [key, def] of Object.entries(spec)) {
    const param = params[key];
    if (def.required && !param) {
      errors.push({ path: `/parameters/${key}`, message: `required parameter missing: ${key}` });
      continue;
    }
    if (!param) continue;

    if (param.type !== def.type) {
      errors.push({ path: `/parameters/${key}/type`, message: `expected type ${def.type}, got ${param.type}` });
      continue;
    }

    const val = param.value;
    if (def.type === 'string') {
      if (typeof val !== 'string') {
        errors.push({ path: `/parameters/${key}/value`, message: `expected string value` });
        continue;
      }
      if (CONTROL_CHAR_RE.test(val)) {
        errors.push({ path: `/parameters/${key}/value`, message: `contains control characters` });
      }
      if (def.maxLength && val.length > def.maxLength) {
        errors.push({ path: `/parameters/${key}/value`, message: `exceeds max length ${def.maxLength}` });
      }
      if (def.minLength && val.length < def.minLength) {
        errors.push({ path: `/parameters/${key}/value`, message: `below min length ${def.minLength}` });
      }
      if (val.length > MAX_PARAM_VALUE_LENGTH) {
        errors.push({ path: `/parameters/${key}/value`, message: `exceeds absolute max length ${MAX_PARAM_VALUE_LENGTH}` });
      }
      if (def.pattern && !def.pattern.test(val)) {
        errors.push({ path: `/parameters/${key}/value`, message: `value "${val}" does not match the required format for ${key}` });
      }
    } else if (def.type === 'boolean') {
      if (typeof val !== 'boolean') {
        errors.push({ path: `/parameters/${key}/value`, message: `expected boolean value` });
      }
    } else if (def.type === 'integer') {
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        errors.push({ path: `/parameters/${key}/value`, message: `expected integer value` });
      }
    }
  }
}

function validateIdentityFields(pkgName, pkgVersion, errors) {
  if (!NPM_NAME_RE.test(pkgName)) {
    errors.push({ path: '/parameters/package_name', message: `invalid npm package name: ${pkgName}` });
  }
  if (!SEMVER_RE.test(pkgVersion)) {
    errors.push({ path: '/parameters/package_version', message: `invalid semver: ${pkgVersion}` });
  }
  if (PATH_TRAVERSAL_RE.test(pkgName) || PATH_TRAVERSAL_RE.test(pkgVersion)) {
    errors.push({ path: '/identity', message: 'path traversal attempt in identity fields' });
  }
  if (ABSOLUTE_PATH_RE.test(pkgName) || ABSOLUTE_PATH_RE.test(pkgVersion)) {
    errors.push({ path: '/identity', message: 'absolute path in identity fields' });
  }
  if (pkgName.includes('\\') || pkgVersion.includes('\\')) {
    errors.push({ path: '/identity', message: 'backslash in identity fields' });
  }
}

function validateOutputPath(outputDir, absBase, errors) {
  const normalizedOutput = resolve(outputDir);
  const normalizedBase = resolve(absBase);
  if (!normalizedOutput.startsWith(normalizedBase + '/')) {
    errors.push({ path: '/output', message: `output directory escapes allowed base: ${normalizedOutput}` });
  }
}

function validateGeneratedContent(files, errors) {
  let totalBytes = 0;
  for (const [name, content] of files) {
    if (typeof content !== 'string') {
      errors.push({ path: `/files/${name}`, message: 'content must be a string' });
      continue;
    }
    totalBytes += Buffer.byteLength(content, 'utf-8');
    if (CONTROL_CHAR_RE.test(content.replace(/[\n\r\t]/g, ''))) {
      errors.push({ path: `/files/${name}`, message: 'content contains unexpected control characters' });
    }
  }
  if (totalBytes > MAX_TOTAL_OUTPUT_BYTES) {
    errors.push({ path: '/files', message: `total output size ${totalBytes} exceeds limit ${MAX_TOTAL_OUTPUT_BYTES}` });
  }
}

function writeAtomically(outputDir, files, absBase) {
  mkdirSync(outputDir, { recursive: true });

  checkForSymlinks(outputDir, absBase);

  const written = [];
  try {
    for (const [filename, content] of files) {
      const finalPath = join(outputDir, filename);
      const tmpPath = join(outputDir, `.tmp-${randomBytes(8).toString('hex')}-${filename}`);

      const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, filename.endsWith('.sh') ? 0o755 : 0o644);
      try {
        writeSync(fd, content, 0, 'utf-8');
      } finally {
        closeSync(fd);
      }

      renameSync(tmpPath, finalPath);
      written.push(finalPath);
    }
  } catch (err) {
    for (const path of written) {
      try { unlinkSync(path); } catch {}
    }
    throw err;
  }
}

function checkForSymlinks(dir, absBase) {
  let current = resolve(dir);
  const base = resolve(absBase);
  while (current.startsWith(base)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new RenderError(`symlink detected in output path: ${current}`);
      }
    } catch (e) {
      if (e instanceof RenderError) throw e;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

export { TEMPLATES, ALLOWED_BASE, FIXED_FILENAMES };
