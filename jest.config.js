/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],

  // Run suites one at a time.
  //
  // Every integration suite shares one PostgreSQL database and truncates
  // `entries`, `transactions` and `accounts` in beforeEach (see
  // test/integration/helpers/db.ts). Under Jest's default parallel workers, one
  // suite's truncate can wipe another suite's fixtures mid-test, so a failure
  // becomes ambiguous: it could mean the code is wrong, or merely that a
  // concurrent worker deleted the rows out from under the assertion.
  //
  // That ambiguity is unacceptable for the concurrency and balance-invariant
  // work, whose entire value is that a red result means the invariant was
  // actually violated. Set here rather than as --runInBand in the npm scripts so
  // it also holds when Jest is invoked directly (npx jest, IDE runners, CI
  // steps that bypass the scripts).
  maxWorkers: 1,
};
