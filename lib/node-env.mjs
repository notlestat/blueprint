// Blueprint starts its own scripts (server.mjs, mcp.mjs) with process.execPath,
// the program that is running right now. From a terminal that is Node. In the
// desktop app it is the Blueprint app itself, which would open a second window
// instead of running the script. ELECTRON_RUN_AS_NODE makes it run as Node.
//
// Only the environment of these child processes gets the flag. Setting it on
// the app's own process.env would reach Chromium's helper processes too, and
// they would start as Node and break the window.
export const nodeEnv = (env = process.env) => (process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env);
