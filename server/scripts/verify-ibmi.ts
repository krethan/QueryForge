/**
 * Uncle Bob IBM i verification kit - run it yourself against a NON-PRODUCTION IBM i.
 *
 *   npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod            read-only checks
 *   npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod \
 *       --apply-migrations --cleanup UBVERIFY                                    full round trip
 *
 * It refuses to connect unless QF_VERIFY_TARGET=nonprod and --confirm-nonprod are both given.
 * It reads only QF_VERIFY_* settings (never server/.env). See docs/ibmi-verification.md.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOptions, USAGE } from './verify/options.js';
import { exitCode, formatReport } from './verify/report.js';
import { runVerification } from './verify/run.js';

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  let options;
  try {
    options = parseOptions(argv, env);
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const report = await runVerification(options);
  console.log(formatReport(report));
  try {
    writeFileSync(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nJSON report written to ${options.jsonPath}`);
  } catch (e) {
    console.error(`Could not write ${options.jsonPath}: ${(e as Error).message}`);
  }
  return exitCode(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Verification kit crashed: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
