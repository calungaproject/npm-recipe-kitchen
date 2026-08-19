import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHostFiles,
  isPreScriptOutputSrc,
  checkHostFileValidation,
  validateHarnessFiles,
} from '../scripts/lib/validate-harness-files.mjs';

describe('parseHostFiles', () => {
  it('parses a block sequence of entries with continuation fields', () => {
    const doc = [
      'host_files:',
      '    - src: env/gcp-vertex.env',
      '      dest: /sandbox/workspace/.env.d/gcp-vertex.env',
      '      expand: true',
      '    - src: /tmp/staged/recipe-input.json',
      '      dest: /sandbox/workspace/recipe-input.json',
      '      optional: true',
      '',
    ].join('\n');
    assert.deepStrictEqual(parseHostFiles(doc), [
      { src: 'env/gcp-vertex.env', optional: false },
      { src: '/tmp/staged/recipe-input.json', optional: true },
    ]);
  });

  it('stops at the next top-level key', () => {
    const doc = 'host_files:\n    - src: a\n      optional: true\npre_script: x.sh\n';
    assert.deepStrictEqual(parseHostFiles(doc), [{ src: 'a', optional: true }]);
  });

  it('returns an empty list when host_files is absent', () => {
    assert.deepStrictEqual(parseHostFiles('agent: x\nrole: coder\n'), []);
  });

  it('ignores commented-out entries', () => {
    const doc = 'host_files:\n    - src: a\n    # - src: /tmp/old.json\n    - src: b\n      optional: true\n';
    assert.deepStrictEqual(parseHostFiles(doc), [
      { src: 'a', optional: false },
      { src: 'b', optional: true },
    ]);
  });
});

describe('isPreScriptOutputSrc', () => {
  it('flags a literal absolute path', () => {
    assert.strictEqual(isPreScriptOutputSrc('/tmp/staged/recipe-input.json'), true);
  });

  it('does not flag an env-var indirection', () => {
    assert.strictEqual(isPreScriptOutputSrc('${GOOGLE_APPLICATION_CREDENTIALS}'), false);
  });

  it('does not flag a relative (committed) path', () => {
    assert.strictEqual(isPreScriptOutputSrc('env/gcp-vertex.env'), false);
  });

  it('does not flag an empty src', () => {
    assert.strictEqual(isPreScriptOutputSrc(null), false);
  });
});

describe('checkHostFileValidation', () => {
  it('flags a non-optional literal absolute src that the pre-script produces', () => {
    const doc = [
      'pre_script: mk/facts.sh',
      'host_files:',
      '    - src: /tmp/staged/recipe-input.json',
      '      dest: /sandbox/workspace/recipe-input.json',
      '',
    ].join('\n');
    const errors = checkHostFileValidation(doc, 'harness/x.yaml');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /host_files\[0\]/);
    assert.match(errors[0], /optional: true/);
    assert.match(errors[0], /BEFORE the pre-script/);
  });

  it('passes once the entry is marked optional', () => {
    const doc = [
      'pre_script: mk/facts.sh',
      'host_files:',
      '    - src: /tmp/staged/recipe-input.json',
      '      dest: /sandbox/workspace/recipe-input.json',
      '      optional: true',
      '',
    ].join('\n');
    assert.deepStrictEqual(checkHostFileValidation(doc, 'harness/x.yaml'), []);
  });

  it('ignores env-var and relative sources', () => {
    const doc = [
      'host_files:',
      '    - src: env/gcp-vertex.env',
      '      dest: /sandbox/workspace/.env.d/gcp-vertex.env',
      '    - src: ${GOOGLE_APPLICATION_CREDENTIALS}',
      '      dest: /tmp/.gcp-credentials.json',
      '',
    ].join('\n');
    assert.deepStrictEqual(checkHostFileValidation(doc, 'harness/x.yaml'), []);
  });

  it('reports the entry index of the offending host_file', () => {
    const doc = [
      'pre_script: mk/facts.sh',
      'host_files:',
      '    - src: env/gcp-vertex.env',
      '    - src: ${GCP_OIDC_TOKEN_FILE}',
      '      optional: true',
      '    - src: /tmp/staged/recipe-input.json',
      '',
    ].join('\n');
    const errors = checkHostFileValidation(doc, 'harness/x.yaml');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /host_files\[2\]/);
  });
});

describe('repository configuration', () => {
  it('leaves no pre-script output non-optional in any harness', () => {
    assert.deepStrictEqual(validateHarnessFiles(), []);
  });
});
