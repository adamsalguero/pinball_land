const { app, BrowserWindow } = require("electron");

app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 320, height: 240 });
  win.loadURL("data:text/html,<title>ok</title>");
  win.webContents.once("did-finish-load", () => {
    console.log("electron-smoke-ok");
    app.exit(0);
  });
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

setTimeout(() => {
  console.error("electron-smoke timed out");
  app.exit(1);
}, 20000);
