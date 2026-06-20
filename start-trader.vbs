' ============================================================
'  AI TRADER — Silent Background Launcher
'  Double-click THIS file to start the trader with no window
'  It runs start-trader.bat invisibly in the background
' ============================================================

Dim WshShell, scriptDir, batFile

Set WshShell = CreateObject("WScript.Shell")

' Get the folder this VBS file lives in
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

batFile = scriptDir & "\start-trader.bat"

' Run the bat file — 0 = hidden window, False = don't wait for it to finish
WshShell.Run "cmd /c """ & batFile & """", 0, False

Set WshShell = Nothing
