using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class OpenProductOSLauncher
{
    [STAThread]
    private static void Main()
    {
        try
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(directory, "OpenProductOS.ps1");
            if (!File.Exists(script))
            {
                MessageBox.Show("OpenProductOS.ps1 was not found beside the launcher.", "Open Product Operations OS", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            var start = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = false
            };
            using (Process process = Process.Start(start))
            {
                if (process == null)
                {
                    throw new InvalidOperationException("PowerShell could not be started.");
                }
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    MessageBox.Show(
                        "Setup could not start. Run OpenProductOS.cmd from the same folder to keep the detailed error visible.",
                        "Open Product Operations OS",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Open Product Operations OS", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
