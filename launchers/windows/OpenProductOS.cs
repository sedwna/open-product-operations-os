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
            Process.Start(start);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Open Product Operations OS", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
