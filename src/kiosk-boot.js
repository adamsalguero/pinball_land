// The logon server can fail (permissions, a locked state file) after the kiosk
// window is already up. Stay open and try again instead of quitting the wall.
function bootPlan({ serverReady }) {
  if (serverReady) {
    return { quit: false, screen: "displays", retry: false };
  }
  return { quit: false, screen: "waiting", retry: true };
}

module.exports = { bootPlan };
