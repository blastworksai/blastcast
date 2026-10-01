// CodexBWAI — inspect the short synthetic saved-file timeline independently
// of the shipping finalizer. Never decode/copy media payload into the report.
function webmTimeline(bytes) {
  const tracks = new Map(); const types = new Map(); let scale = 1000000;
  function integer(at, keepMarker = false) {
    const first = bytes[at]; if (!first) throw new Error('Invalid fixture EBML');
    let length = 1; while (!(first & (128 >> (length - 1)))) length++;
    if (length > 8 || at + length > bytes.length) throw new Error('Truncated fixture EBML');
    let value = BigInt(keepMarker ? first : first & ((128 >> (length - 1)) - 1));
    for (let i = 1; i < length; i++) value = value * 256n + BigInt(bytes[at + i]);
    return { length, value: !keepMarker && value === (1n << BigInt(7 * length)) - 1n ? null : Number(value) };
  }
  function entries(start, end) {
    const result = [];
    while (start < end) {
      const id = integer(start, true), size = integer(start + id.length);
      const data = start + id.length + size.length;
      const stop = size.value === null ? end : data + size.value;
      if (stop > end || stop < data) throw new Error('Invalid fixture EBML extent');
      result.push({id:id.value,data,end:stop}); start = stop;
    }
    return result;
  }
  function uint(entry) { return Number(BigInt('0x' + bytes.subarray(entry.data, entry.end).toString('hex'))); }
  function visit(start, end, depth = 0) {
    if (depth > 2000) throw new Error('Fixture exceeds short recording limit');
    let time = 0;
    for (const entry of entries(start,end)) {
      if (entry.id === 0x18538067 || entry.id === 0x1f43b675) visit(entry.data,entry.end,depth+1);
      else if (entry.id === 0x1549a966) { for (const field of entries(entry.data,entry.end)) if (field.id===0x2ad7b1) scale=uint(field); }
      else if (entry.id === 0x1654ae6b) {
        for (const track of entries(entry.data,entry.end).filter(e=>e.id===0xae)) {
          const fields=entries(track.data,track.end), id=fields.find(e=>e.id===0xd7), type=fields.find(e=>e.id===0x83);
          if(id&&type)types.set(uint(id),uint(type));
        }
      } else if (entry.id === 0xe7) time=uint(entry);
      else if (entry.id === 0xa3) {
        const track=integer(entry.data); const stamp=time+bytes.readInt16BE(entry.data+track.length);
        const current=tracks.get(track.value)??{first:stamp,last:stamp,blocks:0,maxGap:0};
        current.maxGap=Math.max(current.maxGap,stamp-current.last); current.last=stamp; current.blocks++;
        tracks.set(track.value,current);
      }
    }
  }
  visit(0,bytes.length);
  return [...tracks].map(([id,t])=>({id,type:types.get(id),blocks:t.blocks,firstSeconds:t.first*scale/1e9,lastSeconds:t.last*scale/1e9,maxGapSeconds:t.maxGap*scale/1e9}));
}
module.exports={webmTimeline};
