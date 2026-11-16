const latin1 = (bytes) => {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return s;
};

export async function inspectBitstream(buffer, filename = 'design.sof') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let sha256 = '';
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { sha256 = '(sha-256 unavailable)'; }
  const text = latin1(bytes);
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const kind = ext === 'pof' ? 'pof' : ext === 'sof' ? 'sof' : ext === 'rbf' ? 'rbf' : 'bitstream';

  const devMatch = text.match(/EP[34]C[ESGX]?\d+[A-Z]\d+[A-Z]\d+[A-Z]?/i)
    || text.match(/(10CL\d+[A-Z]\d+[A-Z]\d+|EP4CE\d+[A-Z]\d+[A-Z]\d+)/i);
  const device = devMatch ? devMatch[0].toUpperCase() : null;
  let family = null;
  if (device) {
    if (/^EP4CGX/.test(device)) family = 'Cyclone IV GX';
    else if (/^EP4CE/.test(device)) family = 'Cyclone IV E';
    else if (/^EP3C/.test(device)) family = 'Cyclone III';
    else if (/^10CL/.test(device)) family = 'Cyclone 10 LP';
  }
  const verMatch = text.match(/(\d+\.\d+\.\d+\s+Build\s+\d+)/i) || text.match(/Quartus[^\n\r]{0,40}(\d+\.\d+(?:\.\d+)?)/i) || text.match(/Version\s+(\d+\.\d+(?:\.\d+)?)/i);
  const version = verMatch ? verMatch[1] : null;
  const dateMatch = text.match(/(\d{4}[\/-]\d{2}[\/-]\d{2})/) || text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i);
  const date = dateMatch ? dateMatch[1] : null;
  const compression = /compression\s*=\s*on/i.test(text) || text.includes('COMPRESSED');

  return {
    filename, kind, size: bytes.length, sha256, device, family, version, date, compression,
    deviceMatch: /^EP4CE6E22C8N?$/i.test(device || ''),
    note: 'Metadata is extracted heuristically, not validated configuration data. Intel-proprietary logic is not executed. Run VHDL source or a compatible VHO netlist with its vendor libraries, or replay a VCD waveform.',
  };
}