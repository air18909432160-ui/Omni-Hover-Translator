import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);

// Include one named top-level folder so users can extract to a permanent path.
export async function zipDirectory(source, destination) {
  const directory = path.resolve(source), output = path.resolve(destination);
  if (!(await stat(directory)).isDirectory() || !output.endsWith('.zip') || output.startsWith(directory + path.sep)) {
    throw new Error('Invalid archive source or destination');
  }
  await mkdir(path.dirname(output), { recursive: true });
  await rm(output, { force: true });
  if (process.platform === 'win32') {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:OHT_ARCHIVE_SOURCE, $env:OHT_ARCHIVE_DESTINATION, [System.IO.Compression.CompressionLevel]::Optimal, $true)"
    ], { env: { ...process.env, OHT_ARCHIVE_SOURCE: directory, OHT_ARCHIVE_DESTINATION: output } });
  } else {
    await execute('zip', ['-q', '-r', output, path.basename(directory)], { cwd: path.dirname(directory) });
  }
  return output;
}
