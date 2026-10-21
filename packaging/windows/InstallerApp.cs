using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Установщик Zaily Urpaq")]
[assembly: AssemblyProduct("Zaily Urpaq")]
[assembly: AssemblyDescription("Установка школьной платформы Zaily Urpaq")]
[assembly: AssemblyCompany("Zaily Urpaq")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class InstallerApp
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
        {
            Environment.ExitCode = ValidateEmbeddedPayload() ? 0 : 1;
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        if (args.Length > 0 && String.Equals(args[0], "--launch", StringComparison.OrdinalIgnoreCase))
        {
            Application.Run(new LaunchForm(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "packaging\\windows\\Launch.ps1")));
            return;
        }
        if (args.Length > 0 && String.Equals(args[0], "--start-server", StringComparison.OrdinalIgnoreCase))
        {
            RunStartupServer(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "packaging\\windows\\Start-Server.ps1"));
            return;
        }
        if (args.Length > 0 && String.Equals(args[0], "--reset-admin", StringComparison.OrdinalIgnoreCase))
        {
            if (!IsAdministrator())
            {
                try
                {
                    var start = new ProcessStartInfo(Application.ExecutablePath, "--reset-admin") { UseShellExecute = true, Verb = "runas" };
                    Process.Start(start);
                }
                catch (System.ComponentModel.Win32Exception ex)
                {
                    if (ex.NativeErrorCode != 1223)
                        MessageBox.Show("Для восстановления пароля нужны права администратора Windows.", "Zaily Urpaq", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                return;
            }
            Application.Run(new AdminRecoveryForm(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "packaging\\windows\\Reset-Admin-Password.ps1")));
            return;
        }

        if (!IsAdministrator())
        {
            try
            {
                var start = new ProcessStartInfo(Application.ExecutablePath, "--elevated") { UseShellExecute = true, Verb = "runas" };
                Process.Start(start);
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                if (ex.NativeErrorCode != 1223)
                    MessageBox.Show("Установщику нужны права администратора Windows, чтобы открыть доступ в школьной сети.", "Zaily Urpaq", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            return;
        }

        Application.Run(new InstallerForm());
    }

    private static bool ValidateEmbeddedPayload()
    {
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            using (var deployment = assembly.GetManifestResourceStream("Deployment.zip"))
            using (var installScript = assembly.GetManifestResourceStream("Install.ps1"))
            using (var logo = assembly.GetManifestResourceStream("BrandLogo.jpg"))
            {
                if (deployment == null || deployment.Length < 4 || installScript == null || logo == null)
                    return false;
                return deployment.ReadByte() == 0x50 && deployment.ReadByte() == 0x4B;
            }
        }
        catch
        {
            return false;
        }
    }

    private static bool IsAdministrator()
    {
        using (var identity = WindowsIdentity.GetCurrent())
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static void RunStartupServer(string script)
    {
        if (!File.Exists(script)) return;
        try
        {
            var process = Process.Start(CreateHiddenPowerShell(script));
            if (process != null) process.WaitForExit();
        }
        catch { }
    }

    internal static ProcessStartInfo CreateHiddenPowerShell(string script)
    {
        return new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"),
            Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"",
            WorkingDirectory = Path.GetDirectoryName(script),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
    }
}

internal sealed class InstallerForm : Form
{
    private static readonly Color Purple = Color.FromArgb(91, 22, 107);
    private static readonly Color Ink = Color.FromArgb(39, 27, 49);
    private static readonly Color Muted = Color.FromArgb(124, 113, 132);
    private static readonly Color Border = Color.FromArgb(230, 224, 234);

    private readonly TextBox folder = new TextBox();
    private readonly TextBox firstName = new TextBox();
    private readonly TextBox lastName = new TextBox();
    private readonly TextBox email = new TextBox();
    private readonly TextBox password = new TextBox();
    private readonly TextBox confirmPassword = new TextBox();
    private readonly TextBox studentAccessCode = new TextBox();
    private readonly CheckBox configureCloudflare = new CheckBox();
    private readonly TextBox cloudflareHostname = new TextBox();
    private readonly TextBox cloudflareToken = new TextBox();
    private readonly Panel cloudflarePanel = new Panel();
    private readonly CheckBox createDesktopShortcut = new CheckBox();
    private readonly Label installPathPreview = new Label();
    private readonly Panel credentialsPanel = new Panel();
    private readonly Label status = new Label();
    private readonly Label hint = new Label();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly Button installButton = new Button();
    private readonly Button detailsButton = new Button();
    private readonly Button recoverAdminButton = new Button();
    private readonly System.Windows.Forms.Timer uiTimer = new System.Windows.Forms.Timer();
    private readonly ConcurrentQueue<string> messages = new ConcurrentQueue<string>();
    private readonly StringBuilder diagnostics = new StringBuilder();
    private readonly StringBuilder addresses = new StringBuilder();
    private Process child;
    private string temporaryDirectory;
    private string adminEmailUsed;
    private string studentAccessCodeUsed;
    private string installationPath;
    private string launcherWarning;
    private bool installationStarted;
    private SetupConfig pendingConfig;
    private bool existingInstall;

    public InstallerForm()
    {
        Text = "Установка Zaily Urpaq";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(800, 760);
        MinimumSize = new Size(800, 640);
        AutoScroll = true;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        BackColor = Color.FromArgb(247, 245, 248);
        Font = new Font("Segoe UI", 9.5f);
        AutoScaleMode = AutoScaleMode.Font;
        BuildLayout();
        folder.TextChanged += delegate { UpdateExistingInstallState(); };
        UpdateExistingInstallState();
        uiTimer.Interval = 250;
        uiTimer.Tick += PollOutput;
        FormClosing += InstallerFormClosing;
    }

    private void BuildLayout()
    {
        var header = new Panel { Dock = DockStyle.Top, Height = 105, Padding = new Padding(38, 18, 38, 8), BackColor = BackColor };
        header.Controls.Add(new PictureBox { Image = LoadBrandLogo(), SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.White, Bounds = new Rectangle(0, 22, 190, 56) });
        header.Controls.Add(new Label { Text = "Установка платформы школы", Font = new Font("Segoe UI", 20, FontStyle.Bold), ForeColor = Ink, AutoSize = true, Location = new Point(212, 28) });
        header.Controls.Add(new Label { Text = "Один компьютер станет сервером для учителей и учеников", Font = new Font("Segoe UI", 9.5f), ForeColor = Muted, AutoSize = true, Location = new Point(214, 64) });
        Controls.Add(header);

        var card = new Panel { Bounds = new Rectangle(30, 110, 740, 810), BackColor = Color.White, Padding = new Padding(32) };
        card.Paint += delegate(object sender, PaintEventArgs e) { ControlPaint.DrawBorder(e.Graphics, card.ClientRectangle, Border, ButtonBorderStyle.Solid); };
        Controls.Add(card);

        card.Controls.Add(new Label { Text = "Настройка сервера", Font = new Font("Segoe UI", 15, FontStyle.Bold), ForeColor = Ink, AutoSize = true, Location = new Point(32, 17) });
        card.Controls.Add(new Label { Text = "Выберите место установки и задайте данные первого администратора.", ForeColor = Muted, AutoSize = true, Location = new Point(33, 47) });

        AddFieldLabel(card, "Место установки", 72);
        folder.Bounds = new Rectangle(32, 94, 555, 36);
        StyleTextBox(folder);
        folder.Text = @"C:\ZailyUrpaq";
        card.Controls.Add(folder);
        var browse = MakeButton("Обзор…", false);
        browse.Bounds = new Rectangle(597, 94, 105, 36);
        browse.Click += BrowseFolder;
        card.Controls.Add(browse);

        installPathPreview.Text = "";
        installPathPreview.ForeColor = Muted;
        installPathPreview.AutoSize = false;
        installPathPreview.Bounds = new Rectangle(33, 132, 670, 18);
        installPathPreview.Font = new Font("Segoe UI", 8.5f);
        card.Controls.Add(installPathPreview);

        credentialsPanel.Bounds = new Rectangle(32, 153, 670, 280);
        credentialsPanel.BackColor = Color.White;
        card.Controls.Add(credentialsPanel);
        AddFieldLabel(credentialsPanel, "Имя", 0);
        AddFieldLabel(credentialsPanel, "Фамилия", 0, 343);
        AddFieldLabel(credentialsPanel, "Email администратора", 72);
        AddFieldLabel(credentialsPanel, "Пароль (не менее 12 символов)", 144);
        AddFieldLabel(credentialsPanel, "Повторите пароль", 144, 343);
        AddFieldLabel(credentialsPanel, "Единый код входа учеников (от 6 символов)", 216);
        AddInput(credentialsPanel, firstName, 22, 22, 38, 300);
        AddInput(credentialsPanel, lastName, 365, 22, 38, 300);
        AddInput(credentialsPanel, email, 22, 94, 38, 643);
        AddInput(credentialsPanel, password, 22, 166, 38, 300);
        AddInput(credentialsPanel, confirmPassword, 365, 166, 38, 300);
        AddInput(credentialsPanel, studentAccessCode, 22, 238, 38, 643);
        password.UseSystemPasswordChar = true;
        confirmPassword.UseSystemPasswordChar = true;

        createDesktopShortcut.Text = "Создать ярлык Zaily Urpaq на рабочем столе";
        createDesktopShortcut.Checked = true;
        createDesktopShortcut.AutoSize = true;
        createDesktopShortcut.Location = new Point(32, 435);
        createDesktopShortcut.ForeColor = Ink;
        card.Controls.Add(createDesktopShortcut);

        recoverAdminButton.Text = "Не могу войти? Восстановить администратора";
        recoverAdminButton.Bounds = new Rectangle(365, 432, 337, 32);
        recoverAdminButton.FlatStyle = FlatStyle.Flat;
        recoverAdminButton.ForeColor = Purple;
        recoverAdminButton.Visible = false;
        recoverAdminButton.Click += RecoverAdmin;
        card.Controls.Add(recoverAdminButton);

        configureCloudflare.Text = "Настроить публичный доступ Cloudflare сейчас (необязательно)";
        configureCloudflare.AutoSize = true;
        configureCloudflare.Location = new Point(32, 474);
        configureCloudflare.ForeColor = Ink;
        configureCloudflare.CheckedChanged += delegate { cloudflarePanel.Enabled = configureCloudflare.Checked; };
        card.Controls.Add(configureCloudflare);

        cloudflarePanel.Bounds = new Rectangle(32, 502, 670, 92);
        cloudflarePanel.Enabled = false;
        card.Controls.Add(cloudflarePanel);
        AddFieldLabel(cloudflarePanel, "Домен Cloudflare (например, school.example.kz)", 0);
        AddFieldLabel(cloudflarePanel, "Токен Cloudflare Tunnel", 0, 343);
        AddInput(cloudflarePanel, cloudflareHostname, 22, 22, 34, 300);
        AddInput(cloudflarePanel, cloudflareToken, 365, 22, 34, 300);
        cloudflareToken.UseSystemPasswordChar = true;

        var cloudflareNote = new Label { Text = "Для внешнего доступа нужны домен и Tunnel Token из Cloudflare. Без них сайт сразу работает в школьной сети; после установки ничего вводить не нужно.", ForeColor = Muted, AutoSize = false, Bounds = new Rectangle(33, 595, 670, 32) };
        card.Controls.Add(cloudflareNote);

        var note = new Label { Text = "Ученики входят в тест по коду комнаты от учителя. Учитель и администратор — по email и паролю.", ForeColor = Muted, AutoSize = false, Bounds = new Rectangle(32, 630, 670, 28) };
        card.Controls.Add(note);

        status.Text = "Готов к установке";
        status.Font = new Font("Segoe UI", 10, FontStyle.Bold);
        status.ForeColor = Ink;
        status.AutoSize = false;
        status.Bounds = new Rectangle(32, 663, 570, 24);
        card.Controls.Add(status);
        hint.Text = "При первом запуске потребуется интернет. Docker может попросить принять лицензию.";
        hint.ForeColor = Muted;
        hint.AutoSize = false;
        hint.Bounds = new Rectangle(32, 688, 670, 42);
        card.Controls.Add(hint);
        progress.Bounds = new Rectangle(32, 734, 670, 12);
        progress.Style = ProgressBarStyle.Marquee;
        progress.MarqueeAnimationSpeed = 22;
        progress.Visible = false;
        card.Controls.Add(progress);

        installButton.Text = "Установить платформу";
        installButton.Bounds = new Rectangle(432, 758, 270, 44);
        installButton.BackColor = Purple;
        installButton.ForeColor = Color.White;
        installButton.FlatStyle = FlatStyle.Flat;
        installButton.FlatAppearance.BorderSize = 0;
        installButton.Font = new Font("Segoe UI", 10, FontStyle.Bold);
        installButton.Cursor = Cursors.Hand;
        installButton.Click += StartInstallation;
        card.Controls.Add(installButton);

        detailsButton.Text = "Показать сведения";
        detailsButton.Bounds = new Rectangle(32, 765, 170, 30);
        detailsButton.FlatStyle = FlatStyle.Flat;
        detailsButton.FlatAppearance.BorderSize = 0;
        detailsButton.ForeColor = Muted;
        detailsButton.Visible = false;
        detailsButton.Click += ShowDetails;
        card.Controls.Add(detailsButton);

    }

    private static void AddFieldLabel(Control parent, string text, int y, int x = 0)
    {
        parent.Controls.Add(new Label { Text = text, ForeColor = Muted, AutoSize = true, Location = new Point(32 + x, y) });
    }

    private static void AddInput(Control parent, TextBox input, int x, int y, int height, int width)
    {
        input.Bounds = new Rectangle(x, y, width, height);
        StyleTextBox(input);
        parent.Controls.Add(input);
    }

    private static void StyleTextBox(TextBox box)
    {
        box.Font = new Font("Segoe UI", 10);
        box.BorderStyle = BorderStyle.FixedSingle;
        box.ForeColor = Ink;
        box.BackColor = Color.White;
    }

    private static Image LoadBrandLogo()
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("BrandLogo.jpg"))
        using (var source = Image.FromStream(stream))
            return new Bitmap(source);
    }

    private static Button MakeButton(string text, bool primary)
    {
        return new Button { Text = text, BackColor = primary ? Purple : Color.White, ForeColor = primary ? Color.White : Ink, FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI", 9.5f), Cursor = Cursors.Hand };
    }

    private void BrowseFolder(object sender, EventArgs e)
    {
        using (var dialog = new FolderBrowserDialog { Description = "Выберите место. В нём установщик создаст папку ZailyUrpaq", ShowNewFolderButton = true })
        {
            if (Directory.Exists(folder.Text)) dialog.SelectedPath = folder.Text;
            if (dialog.ShowDialog(this) == DialogResult.OK) folder.Text = dialog.SelectedPath;
        }
    }

    private string ResolveInstallDirectory(string selectedPath)
    {
        string fullPath = Path.GetFullPath(selectedPath.Trim());
        if (File.Exists(Path.Combine(fullPath, ".setup-complete"))) return fullPath;
        if (String.Equals(Path.GetFileName(fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)), "ZailyUrpaq", StringComparison.OrdinalIgnoreCase)) return fullPath;
        return Path.Combine(fullPath, "ZailyUrpaq");
    }

    private void UpdateExistingInstallState()
    {
        string path = folder.Text.Trim();
        try
        {
            string destination = ResolveInstallDirectory(path);
            existingInstall = File.Exists(Path.Combine(destination, ".setup-complete"));
            installPathPreview.Text = "Файлы платформы будут установлены в: " + destination;
        }
        catch
        {
            existingInstall = false;
            installPathPreview.Text = "";
        }
        credentialsPanel.Enabled = !existingInstall;
        recoverAdminButton.Visible = existingInstall;
        if (existingInstall)
        {
            hint.Text = "Существующая установка: база и аккаунты сохранятся. Если не получается войти, используйте восстановление администратора.";
            installButton.Text = "Обновить и запустить";
        }
        else
        {
            hint.Text = "Папка ZailyUrpaq будет создана автоматически. При первом запуске потребуется интернет.";
            installButton.Text = "Установить платформу";
        }
    }

    private void StartInstallation(object sender, EventArgs e)
    {
        if (installationStarted) return;
        if (String.IsNullOrWhiteSpace(folder.Text)) { ShowValidation("Укажите место установки.", folder); return; }
        string path;
        try { path = ResolveInstallDirectory(folder.Text); }
        catch { ShowValidation("Укажите правильную папку установки.", folder); return; }
        if (path.Length < 4 || path.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows), StringComparison.OrdinalIgnoreCase))
        {
            ShowValidation("Выберите отдельную папку для платформы, например C:\\ZailyUrpaq.", folder);
            return;
        }

        string adminEmail = email.Text.Trim();
        string adminFirstName = firstName.Text.Trim();
        string adminLastName = lastName.Text.Trim();
        string adminPassword = password.Text;
        string accessCode = studentAccessCode.Text.Trim();
        string hostname = cloudflareHostname.Text.Trim();
        string tunnelToken = cloudflareToken.Text.Trim();
        if (configureCloudflare.Checked && (String.IsNullOrWhiteSpace(hostname) || String.IsNullOrWhiteSpace(tunnelToken)))
        {
            ShowValidation("Для Cloudflare укажите домен и Tunnel Token. Для доступа только в школе снимите галочку.", String.IsNullOrWhiteSpace(hostname) ? cloudflareHostname : cloudflareToken);
            return;
        }
        if (!existingInstall)
        {
            try { new System.Net.Mail.MailAddress(adminEmail); }
            catch { ShowValidation("Введите корректный email администратора.", email); return; }
            if (adminFirstName.Length == 0) { ShowValidation("Укажите имя администратора.", firstName); return; }
            if (adminLastName.Length == 0) { ShowValidation("Укажите фамилию администратора.", lastName); return; }
            if (adminPassword.Length < 12) { ShowValidation("Пароль должен содержать не менее 12 символов.", password); return; }
            if (Encoding.UTF8.GetByteCount(adminPassword) > 72) { ShowValidation("Пароль слишком длинный в UTF-8. Допустимо не более 72 байт.", password); return; }
            if (adminPassword != confirmPassword.Text) { ShowValidation("Пароли не совпадают.", confirmPassword); return; }
            if (accessCode.Length < 6 || accessCode.Length > 64) { ShowValidation("Общий код учеников должен содержать от 6 до 64 символов.", studentAccessCode); return; }
        }

        var config = new SetupConfig { installDir = path, email = adminEmail, firstName = adminFirstName, lastName = adminLastName, password = adminPassword, studentAccessCode = accessCode, createDesktopShortcut = createDesktopShortcut.Checked, configureCloudflare = configureCloudflare.Checked, cloudflareHostname = hostname, cloudflareToken = tunnelToken };
        pendingConfig = config;
        installationPath = path;
        adminEmailUsed = adminEmail;
        studentAccessCodeUsed = accessCode;
        password.Clear();
        confirmPassword.Clear();
        studentAccessCode.Clear();
        cloudflareToken.Clear();
        SetInstallingState();
        uiTimer.Start();
        ThreadPool.QueueUserWorkItem(delegate { RunPowerShell(config); });
    }

    private void ShowValidation(string message, Control target)
    {
        MessageBox.Show(this, message, "Проверьте данные", MessageBoxButtons.OK, MessageBoxIcon.Information);
        target.Focus();
    }

    private void RecoverAdmin(object sender, EventArgs e)
    {
        if (installationStarted) return;
        string destination;
        try { destination = ResolveInstallDirectory(folder.Text); }
        catch { ShowValidation("Не удалось определить папку установленной платформы.", folder); return; }
        using (var recovery = new AdminRecoveryForm(Path.Combine(destination, "packaging\\windows\\Reset-Admin-Password.ps1")))
            recovery.ShowDialog(this);
    }

    private void SetInstallingState()
    {
        installationStarted = true;
        installButton.Enabled = false;
        installButton.Text = "Выполняется установка…";
        folder.Enabled = false;
        credentialsPanel.Enabled = false;
        cloudflarePanel.Enabled = false;
        configureCloudflare.Enabled = false;
        recoverAdminButton.Enabled = false;
        status.Text = "Подготавливаю установку…";
        hint.Text = "Не выключайте компьютер. Docker может попросить принять лицензию.";
        progress.Visible = true;
    }

    private void RunPowerShell(SetupConfig config)
    {
        try
        {
            temporaryDirectory = Path.Combine(Path.GetTempPath(), "ZailyUrpaq-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporaryDirectory);
            ExtractResource("Deployment.zip", Path.Combine(temporaryDirectory, "deployment.zip"));
            ExtractResource("Install.ps1", Path.Combine(temporaryDirectory, "install.ps1"));

            var serializer = new JavaScriptSerializer();
            var input = Convert.ToBase64String(Encoding.UTF8.GetBytes(serializer.Serialize(config)));
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"),
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(temporaryDirectory, "install.ps1") + "\"",
                WorkingDirectory = temporaryDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.EnvironmentVariables["ZAILY_INSTALL_PROGRESS"] = "1";
            start.EnvironmentVariables["ZAILY_INSTALLER_EXE"] = Application.ExecutablePath;
            child = new Process { StartInfo = start };
            child.OutputDataReceived += ReceiveOutput;
            child.ErrorDataReceived += ReceiveOutput;
            if (!child.Start()) throw new InvalidOperationException("Не удалось запустить установку.");
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.StandardInput.Write(input);
            child.StandardInput.Close();
            child.WaitForExit();
            messages.Enqueue("EXIT:" + child.ExitCode.ToString());
        }
        catch (Exception ex)
        {
            messages.Enqueue("ERROR: " + ex.Message);
            messages.Enqueue("EXIT:1");
        }
    }

    private static void ExtractResource(string resource, string target)
    {
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
        {
            if (input == null) throw new FileNotFoundException("В установщике отсутствует компонент " + resource + ". Соберите .exe заново.");
            using (var output = File.Create(target)) input.CopyTo(output);
        }
    }

    private void ReceiveOutput(object sender, DataReceivedEventArgs e)
    {
        if (e.Data != null) messages.Enqueue(e.Data);
    }

    private void PollOutput(object sender, EventArgs e)
    {
        string line;
        bool? exit = null;
        while (messages.TryDequeue(out line))
        {
            if (line.StartsWith("STATUS64:", StringComparison.Ordinal)) status.Text = DecodeMessage(line.Substring(9));
            else if (line.StartsWith("ADDRESS64:", StringComparison.Ordinal)) addresses.AppendLine(DecodeMessage(line.Substring(10)));
            else if (line.StartsWith("ERROR64:", StringComparison.Ordinal)) diagnostics.AppendLine(DecodeMessage(line.Substring(8)));
            else if (line.StartsWith("EXIT:", StringComparison.Ordinal)) exit = line.Substring(5) == "0";
            else if (!String.IsNullOrWhiteSpace(line))
            {
                if (diagnostics.Length < 12000) diagnostics.AppendLine(line);
            }
        }

        if (!exit.HasValue) return;
        uiTimer.Stop();
        progress.Visible = false;
        installButton.Enabled = true;
        folder.Enabled = true;
        credentialsPanel.Enabled = !existingInstall;
        cloudflarePanel.Enabled = configureCloudflare.Checked;
        configureCloudflare.Enabled = true;
        recoverAdminButton.Enabled = true;
        installationStarted = false;
        detailsButton.Visible = !exit.Value;
        if (exit.Value)
        {
            pendingConfig = null;
            password.Clear();
            confirmPassword.Clear();
            studentAccessCode.Clear();
            cloudflareToken.Clear();
            try { CreateLauncherShortcuts(); }
            catch (Exception ex)
            {
                launcherWarning = "Ярлык не создан автоматически: " + ex.Message;
                diagnostics.AppendLine(launcherWarning);
            }
            status.Text = "Платформа готова к работе";
            status.ForeColor = Color.FromArgb(35, 130, 85);
            string addressText = addresses.ToString().Trim();
            bool adminCredentialsUnchanged = diagnostics.ToString().Contains("ADMIN_CREDENTIALS_NOT_CHANGED");
            bool certificateTrustPending = diagnostics.ToString().Contains("CERTIFICATE_TRUST_PENDING");
            bool cloudflareHealthPending = diagnostics.ToString().Contains("CLOUDFLARE_HEALTH_PENDING");
            hint.Text = (String.IsNullOrWhiteSpace(addressText) ? "Сайт откроется в браузере." : addressText)
                + (adminCredentialsUnchanged
                    ? "\r\nСуществующие аккаунты сохранены. Пароль из формы обновления не применялся. Используйте восстановление администратора."
                    : (String.IsNullOrWhiteSpace(adminEmailUsed) ? "" : "\r\nВход администратора: " + adminEmailUsed)
                      + (String.IsNullOrWhiteSpace(studentAccessCodeUsed) ? "" : "\r\nОбщий код учеников: " + studentAccessCodeUsed))
                + (certificateTrustPending ? "\r\nВнимание: HTTPS-сертификат не добавлен автоматически. См. сообщение о сертификате." : "")
                + (cloudflareHealthPending ? "\r\nСайт в школьной сети работает, но Cloudflare не прошёл проверку. Сведения сохранены в диагностике." : "")
                + (String.IsNullOrWhiteSpace(launcherWarning) ? "" : "\r\n" + launcherWarning);
            hint.Height = 72;
            hint.ForeColor = certificateTrustPending || cloudflareHealthPending ? Color.DarkOrange : Color.FromArgb(35, 130, 85);
            installButton.Text = "Закрыть";
            installButton.Click -= StartInstallation;
            installButton.Click += delegate { Close(); };
            if (certificateTrustPending)
            {
                string certificatePath = Path.Combine(installationPath, "lan-root-ca.crt");
                MessageBox.Show(this,
                    "Платформа запущена, но Windows не разрешила автоматически добавить её корневой HTTPS-сертификат.\r\n\r\nФайл сохранён здесь:\r\n" + certificatePath + "\r\n\r\nДля открытия сайта без предупреждения о сертификате установите этот сертификат в «Доверенные корневые центры сертификации» текущего пользователя Windows. На других школьных устройствах сертификат также нужно установить отдельно. Не обходите предупреждения TLS.",
                    "Платформа запущена: требуется доверие к HTTPS-сертификату", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            else
            {
                MessageBox.Show(this, "Платформа установлена и готова к работе.", "Готово", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
        else
        {
            if (pendingConfig != null)
            {
                password.Text = pendingConfig.password ?? "";
                confirmPassword.Text = pendingConfig.password ?? "";
                studentAccessCode.Text = pendingConfig.studentAccessCode ?? "";
            }
            status.Text = "Не удалось завершить установку";
            status.ForeColor = Color.FromArgb(174, 55, 68);
            hint.Text = "Данные установки сохранены. Исправьте указанную проблему и запустите установку повторно.";
            installButton.Text = "Повторить";
            MessageBox.Show(this, "Установка не завершена. Нажмите «Показать сведения», чтобы узнать причину.", "Ошибка установки", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        try { if (Directory.Exists(temporaryDirectory)) Directory.Delete(temporaryDirectory, true); } catch { }
    }

    private void ShowDetails(object sender, EventArgs e)
    {
        string text = diagnostics.ToString();
        if (String.IsNullOrWhiteSpace(text)) text = "Установщик завершился с ошибкой. Перезагрузите Windows, проверьте интернет и повторите попытку.";
        using (var dialog = new DetailsForm(text)) dialog.ShowDialog(this);
    }

    private void CreateLauncherShortcuts()
    {
        string installedExe = Path.Combine(installationPath, "ZailyUrpaq.exe");
        string currentExe = Application.ExecutablePath;
        if (!String.Equals(Path.GetFullPath(currentExe), Path.GetFullPath(installedExe), StringComparison.OrdinalIgnoreCase))
            File.Copy(currentExe, installedExe, true);

        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) throw new InvalidOperationException("Не удалось создать ярлык Windows.");
        dynamic shell = Activator.CreateInstance(shellType);
        if (createDesktopShortcut.Checked)
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            CreateShortcut(shell, Path.Combine(desktop, "Zaily Urpaq.lnk"), installedExe, "--launch", installationPath);
            CreateShortcut(shell, Path.Combine(desktop, "Zaily Urpaq - Восстановление пароля администратора.lnk"), installedExe, "--reset-admin", installationPath);
        }
        CreateShortcut(shell, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Zaily Urpaq Server.lnk"), installedExe, "--start-server", installationPath);
        Marshal.FinalReleaseComObject(shell);
    }

    private static void CreateShortcut(dynamic shell, string linkPath, string target, string arguments, string workingDirectory)
    {
        dynamic shortcut = shell.CreateShortcut(linkPath);
        shortcut.TargetPath = target;
        shortcut.Arguments = arguments;
        shortcut.WorkingDirectory = workingDirectory;
        shortcut.Description = "Запустить сервер Zaily Urpaq";
        shortcut.Save();
        Marshal.FinalReleaseComObject(shortcut);
    }

    private static string DecodeMessage(string value)
    {
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
        catch { return "Выполняется установка…"; }
    }

    private void InstallerFormClosing(object sender, FormClosingEventArgs e)
    {
        if (installationStarted)
        {
            e.Cancel = true;
            MessageBox.Show(this, "Дождитесь завершения текущего шага установки. Прервать работу сейчас может оставить платформу настроенной не полностью.", "Установка выполняется", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            uiTimer.Dispose();
            if (child != null) child.Dispose();
        }
        base.Dispose(disposing);
    }

    private sealed class SetupConfig
    {
        public string installDir { get; set; }
        public string email { get; set; }
        public string firstName { get; set; }
        public string lastName { get; set; }
        public string password { get; set; }
        public string studentAccessCode { get; set; }
        public bool createDesktopShortcut { get; set; }
        public bool configureCloudflare { get; set; }
        public string cloudflareHostname { get; set; }
        public string cloudflareToken { get; set; }
    }
}

internal sealed class DetailsForm : Form
{
    public DetailsForm(string details)
    {
        Text = "Сведения об ошибке";
        StartPosition = FormStartPosition.CenterParent;
        Size = new Size(680, 420);
        BackColor = Color.White;
        var output = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, WordWrap = true, Dock = DockStyle.Fill, Font = new Font("Consolas", 9), Text = details };
        var copy = new Button { Text = "Скопировать", Dock = DockStyle.Right, Width = 120 };
        copy.Click += delegate { Clipboard.SetText(output.Text); };
        var close = new Button { Text = "Закрыть", Dock = DockStyle.Right, Width = 100, DialogResult = DialogResult.OK };
        var buttons = new Panel { Dock = DockStyle.Bottom, Height = 46, Padding = new Padding(8) };
        buttons.Controls.Add(close);
        buttons.Controls.Add(copy);
        Controls.Add(output);
        Controls.Add(buttons);
        AcceptButton = close;
    }
}

internal sealed class AdminRecoveryForm : Form
{
    private readonly TextBox email = new TextBox();
    private readonly TextBox password = new TextBox();
    private readonly TextBox confirmPassword = new TextBox();
    private readonly Label status = new Label();
    private readonly Button reset = new Button();
    private readonly Button details = new Button();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly StringBuilder output = new StringBuilder();
    private readonly string script;
    private Process process;

    public AdminRecoveryForm(string scriptPath)
    {
        script = scriptPath;
        Text = "Восстановление администратора — Zaily Urpaq";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(570, 390);
        BackColor = Color.White;
        Font = new Font("Segoe UI", 9.5f);

        Controls.Add(new Label { Text = "Восстановление доступа администратора", Font = new Font("Segoe UI", 15, FontStyle.Bold), ForeColor = Color.FromArgb(39, 27, 49), AutoSize = true, Location = new Point(24, 20) });
        Controls.Add(new Label {
            Text = "Меняется только пароль существующего активного аккаунта ADMIN. Если он один, email можно не указывать.\r\nУченики, задания, оценки и базы данных не удаляются.",
            ForeColor = Color.FromArgb(124, 113, 132), AutoSize = false, Bounds = new Rectangle(26, 58, 520, 42)
        });
        Controls.Add(new Label { Text = "Email администратора (необязательно, если он один)", ForeColor = Color.FromArgb(124, 113, 132), AutoSize = true, Location = new Point(26, 108) });
        email.Bounds = new Rectangle(26, 130, 520, 30);
        email.Font = new Font("Segoe UI", 10);
        Controls.Add(email);
        Controls.Add(new Label { Text = "Новый пароль (не менее 12 символов)", ForeColor = Color.FromArgb(124, 113, 132), AutoSize = true, Location = new Point(26, 168) });
        password.Bounds = new Rectangle(26, 190, 520, 30);
        password.UseSystemPasswordChar = true;
        password.Font = new Font("Segoe UI", 10);
        Controls.Add(password);
        Controls.Add(new Label { Text = "Повторите новый пароль", ForeColor = Color.FromArgb(124, 113, 132), AutoSize = true, Location = new Point(26, 228) });
        confirmPassword.Bounds = new Rectangle(26, 250, 520, 30);
        confirmPassword.UseSystemPasswordChar = true;
        confirmPassword.Font = new Font("Segoe UI", 10);
        Controls.Add(confirmPassword);

        status.Text = "Работает только на этом компьютере-сервере.";
        status.ForeColor = Color.FromArgb(124, 113, 132);
        status.AutoSize = false;
        status.Bounds = new Rectangle(26, 292, 520, 40);
        Controls.Add(status);

        details.Text = "Показать сведения";
        details.Bounds = new Rectangle(26, 346, 155, 30);
        details.FlatStyle = FlatStyle.Flat;
        details.Visible = false;
        details.Click += delegate {
            string text;
            lock (output) { text = output.ToString().Trim(); }
            if (String.IsNullOrWhiteSpace(text)) text = "Дополнительных сведений нет.";
            MessageBox.Show(this, text, "Сведения о восстановлении", MessageBoxButtons.OK, MessageBoxIcon.Information);
        };
        Controls.Add(details);

        reset.Text = "Изменить пароль";
        reset.Bounds = new Rectangle(376, 344, 170, 34);
        reset.BackColor = Color.FromArgb(91, 22, 107);
        reset.ForeColor = Color.White;
        reset.FlatStyle = FlatStyle.Flat;
        reset.Click += ResetPassword;
        Controls.Add(reset);
        AcceptButton = reset;
        timer.Interval = 250;
        timer.Tick += CheckProcess;
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (process != null && !process.HasExited) {
                e.Cancel = true;
                MessageBox.Show(this, "Дождитесь завершения проверки. Не выключайте Docker во время восстановления.", "Операция выполняется", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        };
    }

    private void ResetPassword(object sender, EventArgs e)
    {
        if (process != null && !process.HasExited) return;
        if (!String.IsNullOrWhiteSpace(email.Text))
        {
            try { new System.Net.Mail.MailAddress(email.Text.Trim()); }
            catch { MessageBox.Show(this, "Введите корректный email администратора.", "Неверный email", MessageBoxButtons.OK, MessageBoxIcon.Information); email.Focus(); return; }
        }
        if (password.Text.Length < 12) { MessageBox.Show(this, "Пароль должен содержать не менее 12 символов.", "Слишком короткий пароль", MessageBoxButtons.OK, MessageBoxIcon.Information); password.Focus(); return; }
        if (Encoding.UTF8.GetByteCount(password.Text) > 72) { MessageBox.Show(this, "Пароль слишком длинный в UTF-8. Допустимо не более 72 байт.", "Слишком длинный пароль", MessageBoxButtons.OK, MessageBoxIcon.Information); password.Focus(); return; }
        if (!String.Equals(password.Text, confirmPassword.Text, StringComparison.Ordinal)) { MessageBox.Show(this, "Пароли не совпадают.", "Проверьте пароль", MessageBoxButtons.OK, MessageBoxIcon.Information); confirmPassword.Focus(); return; }
        if (!File.Exists(script)) { MessageBox.Show(this, "Файл восстановления не найден. Запустите обновлённый установщик Zaily Urpaq.", "Компонент отсутствует", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }

        try
        {
            lock (output) { output.Length = 0; }
            var start = InstallerApp.CreateHiddenPowerShell(script);
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            process = new Process { StartInfo = start };
            process.OutputDataReceived += CaptureOutput;
            process.ErrorDataReceived += CaptureOutput;
            if (!process.Start()) throw new InvalidOperationException("Не удалось запустить восстановление.");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            var config = new JavaScriptSerializer().Serialize(new AdminResetConfig { email = email.Text.Trim(), password = password.Text });
            process.StandardInput.Write(Convert.ToBase64String(Encoding.UTF8.GetBytes(config)));
            process.StandardInput.Close();
            password.Clear();
            confirmPassword.Clear();
            email.Enabled = false;
            password.Enabled = false;
            confirmPassword.Enabled = false;
            reset.Enabled = false;
            details.Visible = false;
            status.Text = "Проверяю установку и обновляю пароль…";
            status.ForeColor = Color.FromArgb(124, 113, 132);
            timer.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Не удалось запустить восстановление.\r\n" + ex.Message, "Zaily Urpaq", MessageBoxButtons.OK, MessageBoxIcon.Error);
            if (process != null) { process.Dispose(); process = null; }
            email.Enabled = true; password.Enabled = true; confirmPassword.Enabled = true; reset.Enabled = true;
        }
    }

    private void CaptureOutput(object sender, DataReceivedEventArgs e)
    {
        if (String.IsNullOrWhiteSpace(e.Data)) return;
        lock (output) { if (output.Length < 8000) output.AppendLine(e.Data); }
    }

    private void CheckProcess(object sender, EventArgs e)
    {
        if (process == null || !process.HasExited) return;
        process.WaitForExit();
        int exitCode = process.ExitCode;
        process.Dispose();
        process = null;
        timer.Stop();
        email.Enabled = true;
        password.Enabled = true;
        confirmPassword.Enabled = true;
        reset.Enabled = true;
        reset.Text = "Повторить";
        string result;
        lock (output) { result = output.ToString(); }
        if (exitCode == 0 && result.Contains("ADMIN_PASSWORD_RESET_OK"))
        {
            string accountEmail = "";
            foreach (string line in result.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None))
                if (line.StartsWith("ADMIN_ACCOUNT_EMAIL:", StringComparison.Ordinal)) accountEmail = line.Substring("ADMIN_ACCOUNT_EMAIL:".Length).Trim();
            status.Text = String.IsNullOrWhiteSpace(accountEmail) ? "Пароль обновлён." : "Пароль обновлён для " + accountEmail;
            status.ForeColor = Color.FromArgb(35, 130, 85);
            reset.Text = "Готово";
            reset.Enabled = false;
            MessageBox.Show(this, String.IsNullOrWhiteSpace(accountEmail)
                ? "Пароль администратора изменён. Данные школы сохранены."
                : "Пароль администратора изменён. Входите с email " + accountEmail + " и новым паролем. Данные школы сохранены.",
                "Готово", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else
        {
            status.Text = "Не удалось изменить пароль. Нажмите «Показать сведения».";
            status.ForeColor = Color.Firebrick;
            details.Visible = true;
        }
    }

    private sealed class AdminResetConfig
    {
        public string email { get; set; }
        public string password { get; set; }
    }
}

internal sealed class LaunchForm : Form
{
    private readonly Label status = new Label();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly StringBuilder output = new StringBuilder();
    private readonly string script;
    private Process process;
    private bool finished;

    public LaunchForm(string scriptPath)
    {
        script = scriptPath;
        Text = "Запуск Zaily Urpaq";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(480, 160);
        BackColor = Color.White;
        Font = new Font("Segoe UI", 10);
        status.Text = "Подключаю Docker и запускаю школьный сервер…";
        status.ForeColor = Color.FromArgb(39, 27, 49);
        status.AutoSize = false;
        status.Bounds = new Rectangle(28, 28, 424, 34);
        Controls.Add(status);
        progress.Bounds = new Rectangle(28, 82, 424, 14);
        progress.Style = ProgressBarStyle.Marquee;
        progress.MarqueeAnimationSpeed = 24;
        Controls.Add(progress);
        timer.Interval = 400;
        timer.Tick += CheckServer;
        Shown += BeginStart;
        FormClosing += PreventCloseWhileStarting;
    }

    private void BeginStart(object sender, EventArgs e)
    {
        if (!File.Exists(script))
        {
            MessageBox.Show(this, "Файл запуска сервера не найден. Повторно запустите установщик.", "Zaily Urpaq", MessageBoxButtons.OK, MessageBoxIcon.Error);
            finished = true;
            Close();
            return;
        }
        try
        {
            var start = InstallerApp.CreateHiddenPowerShell(script);
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            process = new Process { StartInfo = start };
            process.OutputDataReceived += CaptureOutput;
            process.ErrorDataReceived += CaptureOutput;
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            timer.Start();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Не удалось запустить сервер.\r\n" + ex.Message, "Zaily Urpaq", MessageBoxButtons.OK, MessageBoxIcon.Error);
            finished = true;
            Close();
        }
    }

    private void CaptureOutput(object sender, DataReceivedEventArgs e)
    {
        if (String.IsNullOrWhiteSpace(e.Data)) return;
        lock (output) { if (output.Length < 8000) output.AppendLine(e.Data); }
    }

    private void CheckServer(object sender, EventArgs e)
    {
        if (process == null || !process.HasExited) return;
        process.WaitForExit();
        timer.Stop();
        finished = true;
        progress.Style = ProgressBarStyle.Blocks;
        if (process.ExitCode == 0)
        {
            status.Text = "Сервер запущен. Сайт откроется в браузере.";
            status.ForeColor = Color.FromArgb(35, 130, 85);
            Close();
            return;
        }
        string details;
        lock (output) { details = output.ToString().Trim(); }
        if (String.IsNullOrWhiteSpace(details)) details = "Проверьте, что Docker Desktop запущен, и повторите запуск. Если проблема останется, обратитесь к сотруднику, который устанавливал сервер.";
        MessageBox.Show(this, "Сервер не запустился.\r\n\r\n" + details, "Zaily Urpaq", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        Close();
    }

    private void PreventCloseWhileStarting(object sender, FormClosingEventArgs e)
    {
        if (!finished && process != null && !process.HasExited)
        {
            e.Cancel = true;
            MessageBox.Show(this, "Подождите, пока Docker запустит сервер.", "Запуск выполняется", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
