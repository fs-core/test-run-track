/**
 * Synthetic TRX generators.
 *
 * The whole point of these: nobody can run `dotnet test` in CI or in an agent
 * sandbox, so the parser has to be verifiable against hand-built TRX that
 * matches what MSTest/NUnit actually emit.
 *
 * Two things real TRX does that are easy to get wrong in a fixture:
 *   - attribute values are XML-escaped, so a data-driven name appears as
 *     name="Foo(&quot;bulk&quot;,25)" not name="Foo("bulk",25)"
 *   - MSTest nests data-driven cases inside <InnerResults>
 */

const NS = 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010';
const CLS = 'Crm.Web.Tests.E2E.Donors.Pank1835DonorGridTests';

const escAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escText = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function guid(i) {
  return `1111111${i}-aaaa-bbbb-cccc-00000000000${i}`;
}

function errorInfo(name, i) {
  const msg = `Timeout 30000ms exceeded waiting for selector "#donor-grid-row-${i}" ` +
    `at https://qa.panorama.local/donors?page=${i}\n` +
    `Session 8f14e45f-ceea-467a-9c1a-9b5a0e5c1d22 <detached>`;
  const stack = `   at Microsoft.Playwright.Core.Frame.WaitForSelectorAsync()\n` +
    `   at ${CLS}.${name}() in C:\\code\\panorama\\qa\\fs_crm\\Tests\\${name}.cs:line 4${i}\n` +
    `   at NUnit.Framework.Internal.TaskAwaitAdapter.Invoke()`;
  return `<Output><ErrorInfo><Message>${escText(msg)}</Message>` +
    `<StackTrace>${escText(stack)}</StackTrace></ErrorInfo></Output>`;
}

function wrap(defs, results) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="00000000-0000-0000-0000-000000000000" name="run" xmlns="${NS}">
<TestDefinitions>${defs.join('')}</TestDefinitions>
<Results>${results.join('')}</Results>
</TestRun>`;
}

/**
 * @param {Array<{name:string, outcome:string, args?:string}>} tests
 */
export function makeTrx(tests) {
  const defs = [];
  const results = [];
  tests.forEach((t, i) => {
    const declared = t.args ? `${t.name}(${t.args})` : t.name;
    const id = guid(i);
    defs.push(
      `<UnitTest id="${id}" name="${escAttr(declared)}">` +
      `<TestMethod codeBase="crm.web.Tests.E2E.dll" className="${CLS}" ` +
      `name="${escAttr(declared)}" /></UnitTest>`,
    );
    results.push(
      `<UnitTestResult testId="${id}" testName="${escAttr(`${CLS}.${declared}`)}" ` +
      `outcome="${t.outcome}" duration="00:00:0${(i % 8) + 2}.4821000">` +
      `${t.outcome === 'Failed' ? errorInfo(t.name, i) : ''}</UnitTestResult>`,
    );
  });
  return wrap(defs, results);
}

/** A run with exactly one test — catches the fast-xml-parser array collapse. */
export function makeSingleTestTrx(outcome = 'Failed') {
  return makeTrx([{ name: 'GridSortsByLastGift', outcome }]);
}

/** MSTest style: parent result with child cases under <InnerResults>. */
export function makeInnerResultsTrx() {
  const id = guid(0);
  const defs = [
    `<UnitTest id="${id}" name="BulkTagApplies">` +
    `<TestMethod codeBase="x.dll" className="${CLS}" name="BulkTagApplies" /></UnitTest>`,
  ];
  const inner = ['Passed', 'Failed', 'Passed'].map((o, i) =>
    `<UnitTestResult testId="${id}" testName="${escAttr(`${CLS}.BulkTagApplies(${i})`)}" ` +
    `outcome="${o}" duration="00:00:01.0000000">` +
    `${o === 'Failed' ? errorInfo('BulkTagApplies', i) : ''}</UnitTestResult>`).join('');
  const results = [
    `<UnitTestResult testId="${id}" testName="${escAttr(`${CLS}.BulkTagApplies`)}" ` +
    `outcome="Failed" duration="00:00:03.0000000"><InnerResults>${inner}</InnerResults></UnitTestResult>`,
  ];
  return wrap(defs, results);
}

export const CLASS_NAME = CLS;

/**
 * Six-run scenario used by the history tests.
 * BulkTagApplies flips repeatedly (flaky). DonorExportRespectsFilter breaks at
 * run 3 and stays broken (a real regression). The rest are stable.
 */
export const SCENARIO = (() => {
  const P = 'Passed', F = 'Failed', S = 'NotExecuted';
  const names = ['GridSortsByLastGift', 'BulkTagApplies', 'DonorExportRespectsFilter',
                 'PledgeScheduleRenders', 'SoftCreditSplitSaves'];
  const grid = [
    [P, P, P, P, P],
    [P, F, P, P, P],
    [P, P, P, P, S],
    [P, F, F, P, P],
    [P, P, F, P, P],
    [P, F, F, P, P],
  ];
  return grid.map((row, runIdx) => makeTrx(
    names.map((name, i) => ({
      name,
      outcome: row[i],
      // exercise argument stripping from run 3 onward. Pass raw quotes here —
      // escAttr does the escaping, so pre-escaping would double it.
      args: runIdx >= 3 && i === 1 ? '"bulk",25' : undefined,
    })),
  ));
})();

export const SCENARIO_NAMES = [
  'GridSortsByLastGift', 'BulkTagApplies', 'DonorExportRespectsFilter',
  'PledgeScheduleRenders', 'SoftCreditSplitSaves',
];
