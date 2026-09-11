'use strict';
const { execFile } = require('child_process');

// Outlook-Telefonfelder -> Bezeichnung im Telefonbuch
const FIELDS = {
  BusinessTelephoneNumber: 'Geschäftlich',
  Business2TelephoneNumber: 'Geschäftlich 2',
  CompanyMainTelephoneNumber: 'Firma',
  MobileTelephoneNumber: 'Mobil',
  HomeTelephoneNumber: 'Privat',
  Home2TelephoneNumber: 'Privat 2',
  PrimaryTelephoneNumber: 'Haupt',
  AssistantTelephoneNumber: 'Assistenz',
  CarTelephoneNumber: 'Auto',
  OtherTelephoneNumber: 'Weitere',
};

// Liest per COM alle Kontaktordner aller Konten im klassischen Outlook und gibt JSON aus.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$fields = @(${Object.keys(FIELDS).map((f) => `'${f}'`).join(', ')})
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$result = New-Object System.Collections.ArrayList
function Read-Folder($folder) {
  if ($folder.DefaultItemType -eq 2) {
    foreach ($item in $folder.Items) {
      if ($item.Class -ne 40) { continue }
      $numbers = @(foreach ($f in $fields) { $v = $item.$f; if ($v) { @{ field = $f; number = [string]$v } } })
      $name = if ($item.FullName) { $item.FullName } else { $item.CompanyName }
      if ($name -and $numbers.Count) { [void]$result.Add(@{ name = [string]$name; company = [string]$item.CompanyName; numbers = $numbers }) }
    }
  }
  foreach ($sub in $folder.Folders) { Read-Folder $sub }
}
foreach ($store in $ns.Stores) { try { Read-Folder $store.GetRootFolder() } catch { } }
ConvertTo-Json -InputObject @($result) -Depth 5 -Compress
`;

function importOutlookContacts() {
  // -EncodedCommand umgeht jedes Quoting-Problem der Kommandozeile
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message);
          reject(new Error(/COM class factory|80040154|Outlook\.Application/i.test(detail)
            ? 'Das klassische Outlook wurde nicht gefunden. Das neue Outlook bietet keinen direkten Zugriff.'
            : `Outlook-Import fehlgeschlagen: ${detail.split(/\r?\n/).find((l) => l.trim()) || err.message}`));
          return;
        }
        try {
          const items = JSON.parse(stdout.trim() || '[]');
          resolve(items.map((c) => ({
            name: c.name,
            company: c.company || '',
            numbers: c.numbers.map((n) => ({ label: FIELDS[n.field] || n.field, number: n.number })),
          })));
        } catch (parseErr) {
          reject(new Error(`Outlook-Antwort nicht lesbar: ${parseErr.message}`));
        }
      });
  });
}

module.exports = { importOutlookContacts };
