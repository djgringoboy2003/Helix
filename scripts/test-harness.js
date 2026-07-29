// Shared bits of the hand-rolled test runner.
//
// Helix has no Jest/Vitest; `scripts/check-regressions.js` transpiles `.ts` on
// the fly and asserts directly. Stage B adds enough domain code that keeping
// every test in one file stops scaling, so the loader + `test()` helper live
// here and suites can sit in `tests/unit/*.test.js`.
//
// `test()` registers rather than runs, so suites can be async (Stage B hashes
// and repositories are promise-based). Failure behaviour is unchanged from the
// original inline version: the first failure aborts the run with a non-zero
// exit code.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const queue = [];

/** Lets `require()` pull in the app's TypeScript services directly. */
function installTypeScriptLoader() {
  if (require.extensions['.ts']) return;
  require.extensions['.ts'] = function loadTypeScript(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}

function test(name, fn) {
  queue.push({ name, fn });
}

/** Loads every `*.test.js` suite in `tests/unit`, sorted for stable output. */
function loadUnitSuites() {
  const dir = path.join(__dirname, '..', 'tests', 'unit');
  if (!fs.existsSync(dir)) return;
  const suites = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.test.js'))
    .sort();
  for (const suite of suites) require(path.join(dir, suite));
}

/** Runs everything registered so far, stopping at the first failure. */
async function run() {
  let passed = 0;
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`);
      console.error(error);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${passed} assertions passed.`);
}

module.exports = { installTypeScriptLoader, loadUnitSuites, run, test };
