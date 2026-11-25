// A small, deterministic two-page PDF with an outline, needing no extra library.
export function makePDF() {
  const stream = (line, y = 730) => `BT /F1 18 Tf 60 ${y} Td (${line}) Tj ET`;
  const first = [
    stream('First PDF sentence. Second PDF sentence!'),
    stream('This sentence continues across', 650),
    stream('two PDF lines and must stay together.', 624),
    stream('A hyphenated trans-', 560),
    stream('lation also joins across lines.', 534)
  ].join('\n');
  const second = stream('Another page has selectable English text.');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
    '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
    '<< /Title (Second chapter) /Parent 8 0 R /Dest [4 0 R /Fit] >>'
  ];
  let output = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { output += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
