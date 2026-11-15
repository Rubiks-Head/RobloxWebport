// _wat2c.mjs — WAT -> readable pseudo-C. Each (func …) becomes a C-ish
// function with expression folding (stack machine -> expr strings).
import fs from 'fs'; import path from 'path';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const IN = path.join(HERE,'funcs'), OUT = path.join(HERE,'cfuncs');
// tokenize one func body
function toks(s){
  const out=[];let i=0;
  while(i<s.length){
    const c=s[i];
    if(c==='('){let d=1,j=i+1;while(j<s.length&&d){if(s[j]==='(')d++;else if(s[j]===')')d--;else if(s[j]==='"'){j++;while(j<s.length&&s[j]!=='"')j++}j++}out.push(s.slice(i,j));i=j;continue}
    if(c===String.fromCharCode(34)){let j=i+1;while(j<s.length&&s[j]!==String.fromCharCode(34))j+=(s.charCodeAt(j)===92?2:1);out.push(s.slice(i,j+1));i=j+1;continue}
    if(c===';'){while(i<s.length&&s[i]!=='\n')i++;continue}
    if(/\s/.test(c)){i++;continue}
    let j=i;while(j<s.length&&!/[\s()]/.test(s[j]))j++;
    out.push(s.slice(i,j));i=j;
  }
  return out;
}
// stack->expr folding for flat (non-folded) instr streams
function trans(body){
  const tk=toks(body);const st=[];const lines=[];let indent='  ';
  const pop=n=>st.length?st.pop():`s${n}`;
  const sink=x=>{lines.push(indent+x+';');};
  const num=v=>/^\d+$/.test(v)?v:v;
  let tn=0;
  for(let i=0;i<tk.length;i++){
    const t=tk[i];
    if(t==='end'){indent=indent.slice(2);lines.push(indent+'}');continue}
    if(t==='else'){lines.push(indent.slice(0,-2)+'} else {');continue}
    if(t==='block'||t==='loop'||t==='try'){lines.push(indent+(t==='loop'?'for(;;) ':'')+'{');indent+='  ';continue}
    if(t==='if'){lines.push(indent+`if(${pop(0)}){`);indent+='  ';continue}
    if(t==='then')continue;
    const a=tk[i+1];
    if(t==='local.get'||t==='global.get'){st.push((t==='local.get'?'l':'g')+a.replace(/\D/g,''));i++;continue}
    if(t==='local.set'||t==='global.set'){sink((t==='local.set'?'l':'g')+a.replace(/\D/g,'')+' = '+pop(0));i++;continue}
    if(t==='local.tee'){const v=pop(0);lines.push(indent+`l${a.replace(/\D/g,'')} = ${v};`);st.push(v);i++;continue}
    if(/^(i32|i64|f32|f64)\.const$/.test(t)){st.push(a);i++;continue}
    if(t==='call'){const n=pop(0);sink(`call(${a})`);st.length=0;i++;continue}
    if(t==='call_indirect'){sink('call_indirect(...)');st.length=0;i++;continue}
    if(t==='return'){lines.push(indent+'return'+(st.length?' '+pop(0):'')+';');continue}
    if(t==='drop'){sink('(void)'+pop(0));continue}
    if(t==='nop'||t==='unreachable'){sink(t==='nop'?'':'TRAP()');continue}
    if(t==='br'||t==='br_if'||t==='br_table'){sink(t+(t==='br_if'?`(${pop(0)})`:'')+' -> '+a);i++;continue}
    const m=t.match(/^(i32|i64|f32|f64|f64x2|v128)\.([a-z_]+)/);
    if(m){
      const op=m[2];
      const bin={add:'+',sub:'-',mul:'*',div_s:'/',div_u:'/',rem_s:'%',rem_u:'%',and:'&',or:'|',xor:'^',shl:'<<',shr_s:'>>',shr_u:'>>',eq:'==',ne:'!=',lt_s:'<',lt_u:'<',le_s:'<=',le_u:'<=',gt_s:'>',gt_u:'>',ge_s:'>=',ge_u:'>=',min:'MIN',max:'MAX'}[op];
      if(bin){const b=pop(1),c=pop(0);st.push(`${c} ${bin} ${b}`);continue}
      if(/^load/.test(op)){const o=tk[i+1]&&tk[i+1].startsWith('offset=')?tk[++i].slice(7):'0';const ad=pop(0);st.push(`*(${m[1]}*)(${ad} + ${o})`);continue}
      if(/^store/.test(op)){const o=tk[i+1]&&tk[i+1].startsWith('offset=')?tk[++i].slice(7):'0';const v=pop(0),ad=pop(0);sink(`*(${m[1]}*)(${ad} + ${o}) = ${v}`);continue}
      if(/^(clz|ctz|popcnt|eqz|neg|abs|sqrt|ceil|floor|trunc|nearest)$/.test(op)){st.push(`${op}(${pop(0)})`);continue}
      if(/^(wrap|extend|convert|reinterpret|demote|promote|trunc)/.test(op)){st.push(`(${m[1]})(${pop(0)})`);continue}
      if(op==='atomic'){const v=st.length?pop(0):'v';st.push(`ATOMIC_${v}`);continue}
      st.push(`${m[1]}_${op}(${st.pop()||''})`);continue;
    }
    if(t==='select'){const c=pop(0),b=pop(0),v=pop(0);st.push(`${v} ? ${b} : ${c}`);continue}
    if(t==='memory.fill'){const n=pop(0),v=pop(0),d=pop(0);sink(`memset(${d}, ${v}, ${n})`);continue}
    if(t==='memory.copy'){const n=pop(0),s=pop(0),d=pop(0);sink(`memmove(${d}, ${s}, ${n})`);continue}
    if(t==='memory.size'){st.push('mem_size');continue}
    if(t==='memory.grow'){st.push(`mem_grow(${pop(0)})`);continue}
    if(t==='memory.atomic.notify'||t==='memory.atomic.wait32'||t==='memory.atomic.wait64'){const b=pop(0),c=pop(0);sink(`${t.replace('memory.atomic.','atomic_')}(${c}, ${b})`);continue}
    if(t==='table.get'||t==='table.set'){const v=pop(0),i2=pop(0);t==='table.get'?st.push(`table[${i2}]`):sink(`table[${i2}] = ${v}`);continue}
    if(t==='ref.null'){st.push('NULL');i++;continue}
    if(t==='ref.func'){st.push('&'+a);i++;continue}
    if(t==='ref.is_null'){st.push(`(${pop(0)} == NULL)`);continue}
    if(t.startsWith('atomic.')){const op=t.slice(7);const v=st.length?pop(0):'v';st.push(`atomic_${op}(${v})`);continue}
    if(t==='i31.get_s'||t==='i31.get_u'){st.push(`i31(${pop(0)})`);continue}
    st.push(`/* ${t} */`);
  }
  return lines.join('\n');
}
// find each (func ... block in a batch file
for(const f of fs.readdirSync(IN).filter(f=>f.endsWith('.wat')).sort()){
  const s=fs.readFileSync(path.join(IN,f),'utf8');
  const w=fs.createWriteStream(path.join(OUT,f.replace('.wat','.c')));
  let i=0,fn=0;
  while(i<s.length){
    const p=s.indexOf('(func',i);
    if(p<0)break;
    // find matching close
    let d=1,j=p+5,inS=false;
    while(j<s.length&&d){const c=s[j];if(inS){if(c===92){j+=2;continue}if(c===34)inS=false;}else if(c===34)inS=true;else if(c===40)d++;else if(c===41)d--;j++}
    const fstr=s.slice(p,j);
    // func name/id: (;N;) or $name
    const m=fstr.match(/\(\s*func\s+(?:\(;(\d+);\)|\$(\S+))?/);
    const name=m?(m[1]?('f'+m[1]):('$'+m[2])):('f'+fn++);
    const sig=fstr.match(/\(type\s+(\d+)\)/);
    w.write(`// ==== ${name} ${sig?('type '+sig[1]):''} ====\n`);
    w.write(`void ${name.replace(/\W/g,'_')}(void) {\n${trans(fstr.slice(fstr.indexOf('\n')>0?fstr.indexOf('\n'):5))}\n}\n\n`);
    i=j;
  }
  w.end();
}
console.log('cfuncs written');
