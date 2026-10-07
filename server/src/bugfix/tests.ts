/** What counts as a test file in a diff — the evidence a fix carries a regression test. */
const TEST_FILE = [
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)test_[^/]+$/,
  /_test\.[^/]+$/,
  /[A-Za-z0-9]Tests?\.[^/]+$/,
  /(^|\/)(test|tests|__tests__|spec|specs)\//,
];

export const isTestFile = (path: string): boolean => TEST_FILE.some(re => re.test(path));
export const testFilesIn = (paths: string[]): string[] => paths.filter(isTestFile);
