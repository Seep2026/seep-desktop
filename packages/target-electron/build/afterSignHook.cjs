const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Allow unsigned local packaging flows.
  if (process.env.SKIP_NOTARIZE === '1') {
    return;
  }

  const appleApiKey = process.env.appleApiKey;
  const appleApiIssuer = process.env.appleApiIssuer;
  const appleApiKeyId = process.env.appleApiKeyId;
  if (!appleApiKey || !appleApiIssuer || !appleApiKeyId) {
    return;
  }

  // non appstore - mac os (dmg)
  const appName = context.packager.appInfo.productFilename;
  return await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleApiKey,
    appleApiIssuer,
    appleApiKeyId
  });
};
