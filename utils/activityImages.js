const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const validKey=value=>typeof value==="string" && uuid.test(value);
export function keys(value) {
    try {
        const list=JSON.parse(value);
        return Array.isArray(list) && list.length<=4 && list.every(validKey) && new Set(list).size===list.length ? list : null;
    } catch {return null;}
}
export function validPhoto(file,maxSide) {
    const b=file?.buffer;
    if(file?.mimetype!=="image/jpeg" || !Buffer.isBuffer(b) || b.length<20 || b.length>800000 ||
        b.readUInt16BE(0)!==0xffd8 || b.readUInt16BE(b.length-2)!==0xffd9) return false;
    let at=2;
    while(at+9<b.length && b[at]===255) {
        const marker=b[at+1], length=b.readUInt16BE(at+2);
        if(length<2 || at+2+length>b.length) return false;
        if(marker===192 || marker===194) {
            const height=b.readUInt16BE(at+5),width=b.readUInt16BE(at+7);
            return length>=8 && height>0 && width>0 && height<=maxSide && width<=maxSide;
        }
        if(marker===218) return false;
        at+=length+2;
    }
    return false;
}

