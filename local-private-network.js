const { execFile } = require('child_process');

function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer
      .from(script, 'utf16le')
      .toString('base64');

    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = String(
            stderr ||
            stdout ||
            error.message ||
            'Windows Mobile Hotspot command failed.'
          ).trim();

          const wrapped = new Error(details);
          wrapped.code = 'HOTSPOT_COMMAND_FAILED';
          reject(wrapped);
          return;
        }

        const output = String(stdout || '').trim();

        if (!output) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(output));
        } catch {
          resolve({ raw: output });
        }
      }
    );
  });
}

function windowsScript(action) {
  const escapedAction = String(action || 'status')
    .replace(/[^a-z]/gi, '');

  return `
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$NetworkInformation = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
$TetheringManagerType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
$TetheringResultType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]

function Await-WinRtOperation($Operation, $ResultType) {
    $Method = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethod -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]

    if (-not $Method) {
        throw 'Windows Runtime async bridge is unavailable.'
    }

    $TaskMethod = $Method.MakeGenericMethod($ResultType)
    $Task = $TaskMethod.Invoke($null, @($Operation))
    $Task.Wait(-1) | Out-Null
    return $Task.Result
}

function Get-BingoConnectionProfile {
    $Profile = $NetworkInformation::GetInternetConnectionProfile()

    if (-not $Profile) {
        $Profile = $NetworkInformation::GetConnectionProfiles() |
            Where-Object { $_.NetworkAdapter -ne $null } |
            Select-Object -First 1
    }

    if (-not $Profile) {
        throw 'Windows has no usable connection profile for Mobile Hotspot. Open Mobile Hotspot settings and configure it once.'
    }

    return $Profile
}

$Profile = Get-BingoConnectionProfile
$Manager = $TetheringManagerType::CreateFromConnectionProfile($Profile)

if ('${escapedAction}' -eq 'start') {
    if ($Manager.TetheringOperationalState.ToString() -ne 'On') {
        $Result = Await-WinRtOperation ($Manager.StartTetheringAsync()) $TetheringResultType
        $ResultStatus = $Result.Status.ToString()

        if ($ResultStatus -notin @('Success', 'AlreadyOn')) {
            $Message = $Result.AdditionalErrorMessage
            if (-not $Message) {
                $Message = "Windows returned tethering status: $ResultStatus"
            }
            throw $Message
        }
    }
}

if ('${escapedAction}' -eq 'stop') {
    if ($Manager.TetheringOperationalState.ToString() -eq 'On') {
        $Result = Await-WinRtOperation ($Manager.StopTetheringAsync()) $TetheringResultType
        $ResultStatus = $Result.Status.ToString()

        if ($ResultStatus -ne 'Success') {
            $Message = $Result.AdditionalErrorMessage
            if (-not $Message) {
                $Message = "Windows returned tethering status: $ResultStatus"
            }
            throw $Message
        }
    }
}

$Configuration = $null
try {
    $Configuration = $Manager.GetCurrentAccessPointConfiguration()
} catch {
    $Configuration = $null
}

$State = $Manager.TetheringOperationalState.ToString()
$ClientCount = 0

try {
    $ClientCount = [int]$Manager.ClientCount
} catch {
    $ClientCount = 0
}

$Ssid = $null
$Passphrase = $null

if ($Configuration) {
    try { $Ssid = $Configuration.Ssid } catch {}
    try { $Passphrase = $Configuration.Passphrase } catch {}
}

[PSCustomObject]@{
    supported = $true
    platform = 'win32'
    state = $State
    running = ($State -eq 'On')
    ssid = $Ssid
    password = $Passphrase
    clientCount = $ClientCount
    message = $null
} | ConvertTo-Json -Compress
`;
}

class LocalPrivateNetwork {
  constructor() {
    this.platform = process.platform;
  }

  getBasicStatus(message = null) {
    return {
      supported: this.platform === 'win32',
      platform: this.platform,
      state: 'Unavailable',
      running: false,
      ssid: null,
      password: null,
      clientCount: 0,
      message: message || (
        this.platform === 'win32'
          ? 'Windows Mobile Hotspot is available when supported by this PC.'
          : 'Automatic private-network control is available in the Windows build.'
      )
    };
  }

  async status() {
    if (this.platform !== 'win32') {
      return this.getBasicStatus();
    }

    try {
      return {
        ...this.getBasicStatus(),
        ...(await runPowerShell(windowsScript('status')))
      };
    } catch (error) {
      return this.getBasicStatus(error.message);
    }
  }

  async start() {
    if (this.platform !== 'win32') {
      const error = new Error(
        'Automatic private-network control can only be tested in the Windows build.'
      );
      error.code = 'WINDOWS_ONLY';
      throw error;
    }

    return {
      ...this.getBasicStatus(),
      ...(await runPowerShell(windowsScript('start'), 30000))
    };
  }

  async stop() {
    if (this.platform !== 'win32') {
      const error = new Error(
        'Automatic private-network control can only be tested in the Windows build.'
      );
      error.code = 'WINDOWS_ONLY';
      throw error;
    }

    return {
      ...this.getBasicStatus(),
      ...(await runPowerShell(windowsScript('stop'), 30000))
    };
  }
}

module.exports = LocalPrivateNetwork;
