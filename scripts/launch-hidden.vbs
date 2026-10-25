' Starts the server, the kiosk, or an update with no console window.
' Usage: wscript.exe //B //Nologo launch-hidden.vbs server|kiosk|boot|nightly|now|retry
Option Explicit

Dim mode, shell, fso, root, nodeExe, command, waitForCommand
mode = ""
waitForCommand = False
If WScript.Arguments.Count >= 1 Then mode = LCase(WScript.Arguments(0))

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root

Function FindNode()
  Dim pathEnv, parts, i, candidate
  pathEnv = shell.ExpandEnvironmentStrings("%PATH%")
  parts = Split(pathEnv, ";")
  For i = 0 To UBound(parts)
    If Len(parts(i)) > 0 Then
      candidate = parts(i)
      If Right(candidate, 1) <> "\" Then candidate = candidate & "\"
      candidate = candidate & "node.exe"
      If fso.FileExists(candidate) Then
        FindNode = candidate
        Exit Function
      End If
    End If
  Next
  FindNode = "node.exe"
End Function

nodeExe = FindNode()

If mode = "server" Then
  command = """" & nodeExe & """ """ & root & "\src\server.js"""
ElseIf mode = "kiosk" Then
  ' Wait so an early Electron exit can still open the wall in Chrome.
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\start-kiosk.ps1"""
  waitForCommand = True
ElseIf mode = "boot" Or mode = "nightly" Or mode = "now" Or mode = "retry" Then
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\invoke-update.ps1"" -Mode " & mode
Else
  WScript.Quit 1
End If

' 0 = hidden window. The kiosk script waits; the others return immediately.
If waitForCommand Then
  shell.Run command, 0, True
Else
  shell.Run command, 0, False
End If
