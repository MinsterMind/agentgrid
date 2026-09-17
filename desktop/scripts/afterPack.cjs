// electron-builder afterPack hook: without an Apple Developer identity we still need a
// *consistent* ad-hoc signature over the whole bundle, otherwise Gatekeeper reports the
// app as "damaged" (Electron's stock ad-hoc signature no longer matches our asar/resources).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=1", appPath], { stdio: "inherit" });
  console.log(`  • ad-hoc signed ${appName}`);
};
