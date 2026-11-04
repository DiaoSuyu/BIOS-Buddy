// ---------------------------------------------------------------------------
// Pure serial (UART) logic: parameter checks, port-list parsing, the PowerShell bridge script,
// and encoding outgoing data (text / HEX / line ending). No vscode, easy to unit test.
//
// The actual I/O runs in a long-lived PowerShell process (see serialPort.ts):
// stdout → raw bytes from the port, unwrapped
// stderr → one control message per line (READY / ERR xxx), never mixed with binary data
// stdin ← one base64 line per write; a DTR:/RTS: prefix drives the control lines
// ---------------------------------------------------------------------------

export type Parity = 'None' | 'Even' | 'Odd' | 'Mark' | 'Space';
export type StopBits = 'One' | 'OnePointFive' | 'Two';
export type FlowControl = 'None' | 'RTS/CTS' | 'XON/XOFF';

export interface SerialConfig {
    port: string;
    baud: number;
    dataBits: number;
    parity: Parity;
    stopBits: StopBits;
    flow: FlowControl;
    dtr: boolean;
    rts: boolean;
}

export interface SerialPortInfo {
    path: string;
    desc: string;
}

export const BAUD_PRESETS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
export const PARITIES: Parity[] = ['None', 'Even', 'Odd', 'Mark', 'Space'];
export const STOP_BITS: StopBits[] = ['One', 'OnePointFive', 'Two'];
export const FLOWS: FlowControl[] = ['None', 'RTS/CTS', 'XON/XOFF'];

/** COM3 / com3 → COM3; anything else (/dev/ttyUSB0, \\.\COM10) is left alone */
export function normalizePortName(raw: unknown): string {
    const s = String(raw ?? '').trim();
    const m = /^com\s*(\d{1,3})$/i.exec(s);
    if (m) return 'COM' + m[1];
    return s;
}

export function isValidPortName(name: string): boolean {
    if (!name) return false;
    if (/^COM\d{1,3}$/i.test(name)) return true;
    return /^(\/dev\/[\w.\-/]+)$/.test(name);          // Non-Windows fallback, display only
}

/**
 * Turn what the panel sends into valid parameters.
 * Anything wrong comes back as { error }; a default never silently replaces a
 * number the user typed.
 */
export function validateConfig(raw: unknown): { cfg: SerialConfig; error?: undefined } | { cfg?: undefined; error: string } {
    const o = (raw ?? {}) as Record<string, unknown>;
    const port = normalizePortName(o.port);
    if (!isValidPortName(port)) return { error: 'Pick a serial port first.' };

    const baud = Math.round(Number(o.baud));
    if (!Number.isFinite(baud) || baud < 50 || baud > 4000000) {
        return { error: `Baud rate "${String(o.baud ?? '')}" is out of range (50 – 4000000).` };
    }
    const dataBits = Math.round(Number(o.dataBits ?? 8));
    if (![5, 6, 7, 8].includes(dataBits)) return { error: `Data bits must be 5, 6, 7 or 8 (got ${dataBits}).` };

    const parity = String(o.parity ?? 'None') as Parity;
    if (!PARITIES.includes(parity)) return { error: `Unknown parity "${parity}".` };
    const stopBits = String(o.stopBits ?? 'One') as StopBits;
    if (!STOP_BITS.includes(stopBits)) return { error: `Unknown stop bits "${stopBits}".` };
    const flow = String(o.flow ?? 'None') as FlowControl;
    if (!FLOWS.includes(flow)) return { error: `Unknown flow control "${flow}".` };

    return {
        cfg: {
            port, baud, dataBits, parity, stopBits, flow,
            // High by default, like most serial tools: on many USB adapters these two lines wake the board
            dtr: o.dtr !== false,
            rts: o.rts !== false,
        },
    };
}

/** PowerShell single-quoted string: double every inner quote */
export function psQuote(s: string): string {
    return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Build the long-lived PowerShell bridge script. All parameters are baked in at generation
 * time (validateConfig has already run), so at runtime it only reads base64 from stdin and never interprets user text.
 */
export function buildPsScript(cfg: SerialConfig): string {
    const lines = [
        "$ErrorActionPreference = 'Stop'",
        // Kill the progress stream: with stderr redirected, .NET pushes progress records through as CLIXML and pollutes the pipe
        "$ProgressPreference = 'SilentlyContinue'",
        '$sp = New-Object System.IO.Ports.SerialPort',
        `$sp.PortName = ${psQuote(cfg.port)}`,
        `$sp.BaudRate = ${cfg.baud}`,
        `$sp.DataBits = ${cfg.dataBits}`,
        `$sp.Parity = [System.IO.Ports.Parity]::${cfg.parity}`,
        `$sp.StopBits = [System.IO.Ports.StopBits]::${cfg.stopBits}`,
        `$sp.Handshake = [System.IO.Ports.Handshake]::${cfg.flow === 'None' ? 'None' : (cfg.flow === 'RTS/CTS' ? 'RequestToSend' : 'XOnXOff')}`,
        `$sp.DtrEnable = ${cfg.dtr ? '$true' : '$false'}`,
        `$sp.RtsEnable = ${cfg.rts ? '$true' : '$false'}`,
        '$sp.ReadBufferSize = 65536',
        '$sp.WriteBufferSize = 8192',
        '$sp.ReadTimeout = 1000',
        'try { $sp.Open() } catch {',
        "  [Console]::Error.WriteLine('ERR ' + $_.Exception.Message)",
        '  exit 2',
        '}',
        '$out = [Console]::OpenStandardOutput()',
        '$buf = New-Object byte[] 65536',
        "[Console]::Error.WriteLine('READY')",
        // Read back the parameters that actually took effect, so a UI/driver mismatch is obvious at a glance
        "$info = 'SET ' + $sp.PortName + ' ' + $sp.BaudRate + ' ' + $sp.DataBits + $sp.Parity.ToString().Substring(0,1) + ' ' + $sp.StopBits.ToString() + ' dtr=' + $sp.DtrEnable + ' rts=' + $sp.RtsEnable + ' open=' + $sp.IsOpen",
        '[Console]::Error.WriteLine($info)',
        // stdin must use the APM async API: Console.In.ReadLineAsync() blocks the main thread,
        // the read loop never gets a turn, and the symptom is "connected but always 0 bytes".
        '$in = [Console]::OpenStandardInput()',
        '$inBuf = New-Object byte[] 4096',
        '$pend = \'\'',
        '$ar = $in.BeginRead($inBuf, 0, 4096, $null, $null)',
        '$quit = $false',
        '$rxTotal = [long]0',
        '$hbAt = [Environment]::TickCount',
        'while (-not $quit) {',
        '  # 1) 串口 -> stdout，一次把缓冲区读干净',
        '  try {',
        '    $n = $sp.BytesToRead',
        '    while ($n -gt 0) {',
        '      if ($n -gt $buf.Length) { $n = $buf.Length }',
        '      $read = $sp.Read($buf, 0, $n)',
        '      if ($read -gt 0) { $out.Write($buf, 0, $read); $out.Flush(); $rxTotal += $read }',
        '      $n = $sp.BytesToRead',
        '    }',
        '  } catch {',
        '    if (-not ($_.Exception -is [System.TimeoutException])) {',
        "      [Console]::Error.WriteLine('ERR ' + $_.Exception.Message)",
        '      break',
        '    }',
        '  }',
        '  # 2) stdin -> 控制命令 / 要发送的字节',
        '  if ($ar.IsCompleted) {',
        '    $got = $in.EndRead($ar)',
        '    if ($got -le 0) { break }',
        '    $pend = $pend + [System.Text.Encoding]::UTF8.GetString($inBuf, 0, $got)',
        '    $ar = $in.BeginRead($inBuf, 0, 4096, $null, $null)',
        '    while ($true) {',
        '      $i = $pend.IndexOf("`n")',
        '      if ($i -lt 0) { break }',
        '      $line = $pend.Substring(0, $i).Trim()',
        '      $pend = $pend.Substring($i + 1)',
        '      if ($line.Length -eq 0) { continue }',
        '      try {',
        "        if ($line -eq 'QUIT') { $quit = $true }",
        "        elseif ($line.StartsWith('DTR:')) { $sp.DtrEnable = ($line.Substring(4) -eq '1') }",
        "        elseif ($line.StartsWith('RTS:')) { $sp.RtsEnable = ($line.Substring(4) -eq '1') }",
        '        else {',
        '          $bytes = [Convert]::FromBase64String($line)',
        '          $sp.Write($bytes, 0, $bytes.Length)',
        '        }',
        "      } catch { [Console]::Error.WriteLine('ERR ' + $_.Exception.Message) }",
        '    }',
        '  }',
        '  # 3) 每 5 秒一次心跳：进程活着但收不到数据时，靠它区分「桥死了」和「板子没说话」',
        '  if ([Environment]::TickCount - $hbAt -gt 5000) {',
        "    [Console]::Error.WriteLine('HB rx=' + $rxTotal + ' buffered=' + $sp.BytesToRead)",
        '    $hbAt = [Environment]::TickCount',
        '  }',
        '  Start-Sleep -Milliseconds 12',
        '}',
        'try { $sp.Close() } catch {}',
        "[Console]::Error.WriteLine('BYE rx=' + $rxTotal)",
    ];
    return lines.join('\r\n') + '\r\n';
}

/** PowerShell -EncodedCommand wants the base64 of a UTF-16LE string */
export function encodePsCommand(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Ask only which ports exist: no WMI involved, so it answers in a few hundred ms.
 * Querying device names through WMI used to share one command with the port list, so a slow
 * WMI at cold start timed the whole thing out and listed nothing - hence two steps: names first, descriptions optional.
 */
export const PORT_NAMES_SCRIPT = [
    "$ProgressPreference = 'SilentlyContinue'",
    '$out = @()',
    'try { $out = @([System.IO.Ports.SerialPort]::GetPortNames()) } catch { $out = @() }',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 2',
].join('\r\n');

/** Device names per port (WMI may be slow; on timeout we simply lose the description) */
export const PORT_DESC_SCRIPT = [
    "$ProgressPreference = 'SilentlyContinue'",
    '$desc = @{}',
    'try {',
    "  Get-CimInstance -ClassName Win32_PnPEntity -OperationTimeoutSec 3 -ErrorAction Stop | ForEach-Object {",
    "    $m = [regex]::Match([string]$_.Name, '\\((COM\\d+)\\)')",
    '    if ($m.Success) { $desc[$m.Groups[1].Value.ToUpper()] = [string]$_.Name }',
    '  }',
    '} catch {}',
    'ConvertTo-Json -InputObject $desc -Compress -Depth 3',
].join('\r\n');

/**
 * Parse the port-probe JSON. ConvertTo-Json emits an empty string for an empty array and
 * collapses a single object into the object itself rather than an array - handle both shapes. Sorted numerically by COM index.
 */
export function parsePortJson(text: string): SerialPortInfo[] {
    const t = String(text ?? '').trim();
    if (!t) return [];
    let data: unknown;
    try { data = JSON.parse(t); } catch { return []; }
    const arr = Array.isArray(data) ? data : [data];
    const out: SerialPortInfo[] = [];
    const seen = new Set<string>();
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const p = normalizePortName(o.path);
        if (!p || seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        const d = typeof o.desc === 'string' && o.desc.trim() ? o.desc.trim() : 'Serial port';
        out.push({ path: p, desc: d });
    }
    const num = (p: string) => {
        const m = /(\d+)$/.exec(p);
        return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
    };
    return out.sort((a, b) => (num(a.path) - num(b.path)) || a.path.localeCompare(b.path));
}

/**
 * Port-name list JSON -> clean array of COM names.
 * ConvertTo-Json yields an empty string for an empty array and a bare string for a single value - handle both.
 */
export function parsePortNames(text: string): string[] {
    const t = String(text ?? '').trim();
    if (!t) return [];
    let data: unknown;
    try { data = JSON.parse(t); } catch { return []; }
    const arr = Array.isArray(data) ? data : [data];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of arr) {
        const p = normalizePortName(typeof item === 'string' ? item : '');
        if (!p || seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        out.push(p);
    }
    const num = (p: string) => {
        const m = /(\d+)$/.exec(p);
        return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
    };
    return out.sort((a, b) => (num(a) - num(b)) || a.localeCompare(b));
}

/** Port description map (COM3 -> "USB-Enhanced-SERIAL CH343 (COM3)"); empty when unavailable */
export function parsePortDescs(text: string): Record<string, string> {
    const t = String(text ?? '').trim();
    if (!t) return {};
    let data: unknown;
    try { data = JSON.parse(t); } catch { return {}; }
    if (!data || typeof data !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        const key = normalizePortName(k);
        const val = typeof v === 'string' ? v.trim() : '';
        if (key && val) out[key.toUpperCase()] = val;
    }
    return out;
}

export type LineEnding = 'none' | 'cr' | 'lf' | 'crlf';
export type SendMode = 'text' | 'hex';

export function lineEndingBytes(kind: LineEnding): Buffer {
    switch (kind) {
        case 'cr': return Buffer.from([0x0d]);
        case 'lf': return Buffer.from([0x0a]);
        case 'crlf': return Buffer.from([0x0d, 0x0a]);
        default: return Buffer.alloc(0);
    }
}

/**
 * HEX input: accepts `48 65 6C 6C 6F` / `0x48,0x65` / `48656C6C6F`.
 * Returns null on illegal characters (the UI reports it, so nothing is dropped silently).
 */
export function parseHexInput(text: string): Buffer | null {
    let s = String(text ?? '');
    if (!s.trim()) return Buffer.alloc(0);
    s = s.replace(/0x/gi, '').replace(/[\s,;:]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(s)) return null;
    if (s.length % 2 === 1) s = '0' + s;              // pad a lone nibble with a leading 0
    return Buffer.from(s, 'hex');
}

/** The single-line input from the UI -> the exact bytes written to the port */
export function buildSendBuffer(text: string, mode: SendMode, eol: LineEnding): { data?: Buffer; error?: string } {
    if (mode === 'hex') {
        const buf = parseHexInput(text);
        if (buf === null) return { error: 'HEX 输入里有非法字符（只允许 0-9 A-F，可用空格分隔）' };
        if (!buf.length) return { error: 'Nothing to send.' };
        return { data: buf };
    }
    if (!text.length) return { error: 'Nothing to send.' };
    return { data: Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(eol)]) };
}

/** Byte count -> human-readable size */
export function formatBytes(n: number): string {
    const v = Math.max(0, Math.round(n || 0));
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1048576).toFixed(2)} MB`;
}

/** One stderr line -> control message; serial data always goes through stdout, so it never mixes in */
export function parseBridgeLine(line: string):
    | { kind: 'ready' }
    | { kind: 'error'; message: string }
    | { kind: 'info'; text: string }
    | { kind: 'other'; text: string } {
    const s = String(line ?? '').trim();
    if (!s) return { kind: 'other', text: '' };
    // With stderr redirected the engine first dumps a CLIXML block (#< CLIXML + <S S="Error">...), treat it all as noise
    if (s.startsWith('#<') || s.startsWith('<')) return { kind: 'other', text: '' };
    if (s === 'READY') return { kind: 'ready' };
    if (s.startsWith('ERR ')) return { kind: 'error', message: s.slice(4).trim() };
    if (s.startsWith('SET ')) return { kind: 'info', text: s.slice(4).trim() };
    if (s.startsWith('HB ')) return { kind: 'info', text: s };
    if (s.startsWith('BYE ')) return { kind: 'info', text: s };
    return { kind: 'other', text: s };
}
