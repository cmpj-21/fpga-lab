; Inno Setup 6 Installer Script for Trace FPGA Workbench
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

[Setup]
AppId={{8F3D9B6E-4D72-4E2A-B81C-7A9C3E52F041}
AppName=Trace FPGA Workbench
AppVersion={#MyAppVersion}
AppVerName=Trace FPGA Workbench {#MyAppVersion}
AppPublisher=Trace FPGA Workbench
DefaultDirName={autopf}\Trace FPGA Workbench
DefaultGroupName=Trace FPGA Workbench
AllowNoIcons=yes
OutputDir=..\dist
OutputBaseFilename=Trace-FPGA-Workbench-Setup-x64
SetupIconFile=native\trace.ico
UninstallDisplayIcon={app}\Trace.exe
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "assocqpf"; Description: "Associate .qpf project files with Trace FPGA Workbench"; GroupDescription: "File associations:"

[Files]
Source: "..\dist\Trace\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Trace FPGA Workbench"; Filename: "{app}\Trace.exe"
Name: "{group}\{cm:UninstallProgram,Trace FPGA Workbench}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Trace FPGA Workbench"; Filename: "{app}\Trace.exe"; Tasks: desktopicon

[Registry]
Root: HKA; Subkey: "Software\Classes\.qpf\OpenWithProgids"; ValueType: string; ValueName: "TraceFPGA.Project"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assocqpf
Root: HKA; Subkey: "Software\Classes\TraceFPGA.Project"; ValueType: string; ValueName: ""; ValueData: "Trace FPGA Project"; Flags: uninsdeletekey; Tasks: assocqpf
Root: HKA; Subkey: "Software\Classes\TraceFPGA.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Trace.exe,0"; Tasks: assocqpf
Root: HKA; Subkey: "Software\Classes\TraceFPGA.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Trace.exe"" ""%1"""; Tasks: assocqpf

[Run]
Filename: "{app}\Trace.exe"; Description: "{cm:LaunchProgram,Trace FPGA Workbench}"; Flags: nowait postinstall skipifsilent
