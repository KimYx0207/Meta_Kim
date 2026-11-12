#!/usr/bin/env node
/** Self-contained README diagrams. Rebuild with this script; --check is read-only.
 * Static text and paths explain the complete relationship. Animation adds a run:
 * outputs accumulate, independent lanes progress, failures return to their owners.
 * No scripts, remote assets, external fonts, foreignObject, or motion-only text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copy, diagramLabels } from './readme-animation-copy.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=path.join(ROOT,'docs/images');
const check=process.argv.includes('--check');
if(process.argv.slice(2).some(a=>a!=='--check'))throw new Error('Usage: node scripts/build-readme-animations.mjs [--check]');
const C={ink:'#17263f',muted:'#566782',blue:'#2968e8',teal:'#0d9488',purple:'#7c56d8',amber:'#ce7b24',line:'#cad7e8',paper:'#f5f8fc'};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const units=s=>[...s].reduce((n,c)=>n+(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000-\u303f\uff01-\uff60\uffe0-\uffe6・…—→←↔]/u.test(c)?1:/[MW@]/.test(c)?.91:/[il.,:;! '|]/.test(c)?.3:.59),0);
function wrap(value,width,size){
 if(Array.isArray(value))return value.flatMap(s=>wrap(s,width,size));
 const rows=[];let line='';
 for(const token of String(value).match(/[A-Za-z0-9_'’\-]+|\s+|./gu)||[]){
  for(const part of units(token)*size>width*.95?[...token]:[token]){
   if(line&&units(line+part)*size>width*.95){rows.push(line.trim());line=part.trimStart();}else line+=part;
  }
 }
 if(line.trim())rows.push(line.trim());return rows;
}
function text(value,x,y,width,{size=32,line=42,fill=C.ink,weight=450,align='start'}={}){
 return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${align}">${wrap(value,width,size).map((s,i)=>`<tspan x="${x}" dy="${i?line:0}">${esc(s)}</tspan>`).join('')}</text>`;
}
function cardSize(row,w,opts={}){
 const badgeHeight=opts.badge?wrap(opts.badge,w-52,25).length*33+15:0;
 return Math.max(opts.minH||0,54+badgeHeight+wrap(row[0],w-52,opts.titleSize||36).length*44+(row[1]?12+wrap(row[1],w-52,opts.bodySize||32).length*42:0)+32);
}
class Diagram{
 constructor(locale,id,t,duration=28){
  Object.assign(this,{locale,id,t,duration,styles:[],parts:[],n:0});
  const tr=wrap(t.title,848,40).length,sr=wrap(t.sub,848,30).length;
  this.top=128+tr*50+sr*39+38;
  this.parts.push(text(copy[locale].brand,480,53,848,{size:24,fill:C.blue,weight:700,align:'middle'}),text(t.title,480,113,848,{size:40,line:50,weight:750,align:'middle'}),text(t.sub,480,125+tr*50,848,{size:30,line:39,fill:C.muted,align:'middle'}),`<path d="M56 ${this.top-24}H904" stroke="#dce5f2" stroke-width="4"/><path class="clock" pathLength="1" d="M56 ${this.top-24}H904" stroke="${C.blue}" stroke-width="4"/>`);
 }
 motion(frames,base=''){
  const name=`m${this.n++}`;this.styles.push(`@keyframes ${name}{${frames}}.${name}{${base};animation:${name} ${this.duration}s ease-in-out infinite}`);return name;
 }
 focus(start,end){const a=start*100,b=end*100;return this.motion(`0%,${a}%{opacity:0}${a+1.2}%,${b-1.2}%{opacity:1}${b}%,100%{opacity:0}`,'opacity:0');}
 label(v,x,y,w,o={}){this.parts.push(text(v,x,y,w,o));return wrap(v,w,o.size||32).length*(o.line||42);}
 card(x,y,w,row,o={}){
  const h=o.h||cardSize(row,w,o),color=o.color||C.blue,start=o.start??.05,end=o.end??.2;
  const focus=this.focus(start,end),done=this.motion(`0%,${end*100}%{opacity:0}${end*100+1.5}%,100%{opacity:1}`,'opacity:1'),grow=this.motion(`0%,${start*100}%{transform:scaleX(0)}${end*100}%,100%{transform:scaleX(1)}`,'transform:scaleX(1);transform-box:fill-box;transform-origin:left center');
  let s=`<g class="node" data-label="${esc(row[0])}" data-box="${x},${y},${w},${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${o.fill||'#fff'}" stroke="${C.line}" stroke-width="1.5"/><rect class="focus ${focus}" x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${color}" fill-opacity=".055" stroke="${color}" stroke-width="3"/>`;
  const align=o.align||'start',textX=align==='middle'?x+w/2:x+26;
  let baseline=y+58;
  if(o.badge){s+=text(o.badge,textX,baseline,w-52,{size:25,line:33,weight:700,fill:color,align});baseline+=wrap(o.badge,w-52,25).length*33+15;}
  s+=text(row[0],textX,baseline,w-52,{size:o.titleSize||36,line:44,weight:700,align});baseline+=wrap(row[0],w-52,o.titleSize||36).length*44+12;
  if(row[1])s+=text(row[1],textX,baseline,w-52,{size:o.bodySize||32,line:42,fill:C.muted,align});
  if(o.progress!==false)s+=`<rect x="${x+26}" y="${y+h-14}" width="${w-52}" height="4" rx="2" fill="#e2e9f3"/><rect class="progress ${grow}" x="${x+26}" y="${y+h-14}" width="${w-52}" height="4" rx="2" fill="${color}"/><g class="completed ${done}"><circle cx="${x+w-20}" cy="${y+20}" r="11" fill="${C.teal}"/><path d="M${x+w-26} ${y+20}l4 4 8-9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  this.parts.push(s+'</g>');return{x,y,w,h,cx:x+w/2,b:y+h};
 }
 wire(d,start,end,{color=C.blue,arrow=true,back=false,transient=false}={}){
  const a=start*100,b=end*100,frames=transient?`0%,${a}%{stroke-dashoffset:1;opacity:0}${a+1}%{opacity:1}${b-1}%{stroke-dashoffset:0;opacity:1}${b+1}%,100%{stroke-dashoffset:0;opacity:0}`:`0%,${a}%{stroke-dashoffset:1;opacity:0}${a+1}%{opacity:1}${b}%,100%{stroke-dashoffset:0;opacity:.8}`;
  const motion=this.motion(frames,'stroke-dashoffset:0;opacity:.65'),marker=arrow?` marker-end="url(#${back?'back-arrow':'arrow'})"`:'';
  this.parts.push(`<path d="${d}" fill="none" stroke="${back?C.purple:C.line}" stroke-width="${back?2.5:3}" stroke-linecap="round" stroke-linejoin="round"${back?' stroke-dasharray="7 8"':''}${marker}/><path class="transfer ${motion}" pathLength="1" d="${d}" fill="none" stroke="${color}" stroke-width="4.5" stroke-dasharray="1" stroke-linecap="round" stroke-linejoin="round"/>`);
 }
 down(a,b,start,end,o={}){this.wire(`M${a.cx} ${a.b}V${b.y}`,start,end,o);}
 finish(bottom){
  const h=Math.ceil(bottom+96+wrap(this.t.footer,848,30).length*39),family=this.locale==='ja-JP'?'"Noto Sans CJK JP","Yu Gothic"':this.locale==='ko-KR'?'"Noto Sans CJK KR","Malgun Gothic"':'"Microsoft YaHei","Noto Sans CJK SC","PingFang SC"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${h}" viewBox="0 0 960 ${h}" role="img" aria-labelledby="title description" lang="${this.locale}" xml:lang="${this.locale}">
<title id="title">${esc(this.t.title)}</title><desc id="description">${esc([this.t.sub,diagramLabels[this.locale].motionDescription,this.t.footer].join(' '))}</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${C.line}" stroke-width="1.6" stroke-linecap="round"/></marker><marker id="back-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1 1L9 5L1 9" fill="none" stroke="${C.purple}" stroke-width="1.6" stroke-linecap="round"/></marker></defs>
<style>text{font-family:${family},Arial,sans-serif}.clock{stroke-dasharray:1;stroke-dashoffset:0;animation:clock ${this.duration}s linear infinite}@keyframes clock{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}${this.styles.join('\n')}@media(prefers-reduced-motion:reduce){*{animation:none!important}.focus,.clock{display:none}.completed{opacity:1}.progress{transform:scaleX(1)}.transfer{stroke-dashoffset:0;opacity:.45}}</style>
<rect width="960" height="${h}" rx="26" fill="${C.paper}"/>
${this.parts.join('\n')}
<path d="M56 ${bottom+35}H904" stroke="${C.line}"/>
${text(this.t.footer,480,bottom+82,848,{size:30,line:39,fill:C.muted,align:'middle'})}
</svg>\n`;
 }
}
function diagrams(locale){
 const c=copy[locale],l=diagramLabels[locale],out={};
 {
  const d=new Diagram(locale,'system-map',c.map),w=404,topH=Math.max(...c.map.cards.slice(0,2).map(row=>cardSize(row,w))),bottomH=Math.max(...c.map.cards.slice(2).map(row=>cardSize(row,w)));
  const y=d.top,centerY=y+topH+96,centerH=cardSize([c.map.center,c.map.centerBody],644),lowerY=centerY+centerH+96,middle={x:158,y:centerY,w:644,h:centerH,cx:480,b:centerY+centerH};
  const coords=[[56,y],[500,y],[56,lowerY],[500,lowerY]],colors=[C.blue,C.purple,C.teal,C.amber];
  coords.forEach(([x,yy],i)=>{const port=i<2?middle.y:middle.b,anchor=i%2?650:310,target=i<2?yy+topH:yy,cy=i<2?port-48:port+48;d.wire(`M${anchor} ${port}C${anchor} ${cy} ${x+w/2} ${cy} ${x+w/2} ${target}`,.04+i*.16,.13+i*.16,{color:colors[i],arrow:false});});
  d.card(middle.x,middle.y,middle.w,[c.map.center,c.map.centerBody],{h:centerH,start:.01,end:.13,fill:'#eaf1ff',progress:false,align:'middle'});
  coords.forEach(([x,yy],i)=>d.card(x,yy,w,c.map.cards[i],{h:i<2?topH:bottomH,color:colors[i],start:.1+i*.16,end:.24+i*.16}));
  const end=lowerY+bottomH,caption=c.map.govern+' · '+c.map.perform;d.label(caption,480,end+68,848,{size:31,line:41,align:'middle',weight:700});
  out['system-map']=d.finish(end+68+wrap(caption,848,31).length*41);
 }
 {
  const t=c.architecture,d=new Diagram(locale,'prd-architecture',t);let y=d.top,previous;
  [t.intent,t.research,t.choice].forEach((row,i)=>{const node=d.card(80,y,800,row,{badge:l.archInputs[i],start:.02+i*.14,end:.15+i*.14,color:[C.blue,C.teal,C.purple][i],align:'middle'});if(previous)d.down(previous,node,.09+i*.14,.15+i*.14);previous=node;y=node.b+62;});
  const heights=[t.cards.slice(0,2),t.cards.slice(2)].map(group=>Math.max(...group.map(row=>cardSize(row,404,{badge:l.output})))),groupY=y,groupH=90+heights[0]+32+heights[1]+22;
  d.parts.push(`<rect x="40" y="${groupY}" width="880" height="${groupH}" rx="25" fill="#eaf1ff" stroke="#bdd0f4"/>`);
  d.wire(`M480 ${previous.b}V${groupY}`,.43,.49);d.label(t.prd,480,groupY+52,820,{size:35,line:44,weight:700,fill:C.blue,align:'middle'});y=groupY+90;
  t.cards.forEach((row,i)=>{const yy=y+(i>1?heights[0]+32:0),x=i%2?500:56;d.card(x,yy,404,row,{h:heights[i>1?1:0],badge:l.output,start:.49+i*.08,end:.65+i*.08,color:i%2?C.purple:C.blue});});
  out['prd-architecture']=d.finish(groupY+groupH);
 }
 {
  const t=c.modules,d=new Diagram(locale,'prd-modules',t);let y=d.top;
  const baseline=d.card(80,y,800,t.baseline,{badge:l.input,start:.02,end:.13,align:'middle'});y=baseline.b+58;
  const module=d.card(80,y,800,t.module,{badge:l.expand,start:.13,end:.26,color:C.purple,align:'middle'});d.down(baseline,module,.1,.17);y=module.b+72;
  const hs=[0,1].map(i=>Math.max(...t.cards.slice(i*2,i*2+2).map(row=>cardSize(row,404)))),groupY=y,groupH=86+hs[0]+28+hs[1]+22;
  d.parts.push(`<rect x="40" y="${groupY}" width="880" height="${groupH}" rx="25" fill="#edf5fb" stroke="#bdd0e2"/>`);
  d.wire(`M480 ${module.b}V${groupY}`,.25,.31,{color:C.purple});d.label(l.moduleDetails,480,groupY+52,820,{size:35,line:44,weight:700,fill:C.purple,align:'middle'});y=groupY+86;
  t.cards.forEach((row,i)=>{const xx=i%2?500:56,yy=y+(i>1?hs[0]+28:0);d.card(xx,yy,404,row,{h:hs[i>1?1:0],start:.3+i*.065,end:.44+i*.065,color:[C.blue,C.teal,C.purple,C.amber][i]});});
  const bottom=groupY+groupH;y=bottom+76;d.wire(`M480 ${bottom}V${y}`,.57,.65,{color:C.teal});
  const tasks=d.card(80,y,800,[t.work,t.workBody],{badge:l.output,start:.65,end:.8,color:C.teal,align:'middle'});y=tasks.b+76;const laneH=Math.max(...t.lanes.map(v=>cardSize([v,''],264)));
  t.lanes.forEach((v,i)=>{const x=56+i*292;d.wire(`M480 ${tasks.b}V${y-34}H${x+132}V${y}`,.8,.85,{color:[C.blue,C.teal,C.purple][i]});d.card(x,y,264,[v,''],{h:laneH,start:.85,end:.94,color:[C.blue,C.teal,C.purple][i]});});out['prd-modules']=d.finish(y+laneH);
 }
 {
  const t=c.stages,d=new Diagram(locale,'eight-stages',t,32),w=376,height=Math.max(...t.cards.map(row=>cardSize([row[0],l.output+' · '+row[2]],w,{badge:row[1]}))),gap=104,coords=[[72,0],[512,0],[512,1],[72,1],[72,2],[512,2],[512,3],[72,3]].map(([x,r])=>[x,d.top+r*(height+gap)]);
  coords.forEach(([x,y],i)=>{if(i<7){const[nx,ny]=coords[i+1],route=ny===y?`M${nx>x?x+w:x} ${y+height/2}H${nx>x?nx:nx+w}`:`M${x+w/2} ${y+height}V${ny}`;d.wire(route,.08+i*.083,.14+i*.083,{color:[C.blue,C.teal,C.purple,C.blue,C.amber,C.purple,C.teal][i]});}});
  const planning=coords[2],execution=coords[3],review=coords[4],verify=coords[6];
  d.wire(`M${review[0]} ${review[1]+height/2}H28V${planning[1]-44}H${planning[0]+w/2}V${planning[1]}`,.77,.84,{color:C.purple,back:true,transient:true});
  d.wire(`M${verify[0]+w} ${verify[1]+height/2}H932V${execution[1]-78}H${execution[0]+w/2}V${execution[1]}`,.86,.94,{color:C.purple,back:true,transient:true});
  t.cards.forEach((row,i)=>{const[x,y]=coords[i];d.card(x,y,w,[row[0],l.output+' · '+row[2]],{h:height,badge:`0${i+1} · ${row[1]}`,start:.01+i*.083,end:.1+i*.083,color:[C.blue,C.teal,C.purple,C.blue,C.amber,C.purple,C.teal,C.amber][i]});});
  const bottom=coords[7][1]+height,titleH=d.label(t.returnTitle,480,bottom+65,848,{size:34,line:44,weight:700,fill:C.purple,align:'middle'});const lines=d.label(l.returnRoutes,480,bottom+80+titleH,848,{size:31,line:41,fill:C.purple,align:'middle'});out['eight-stages']=d.finish(bottom+80+titleH+lines);
 }
 {
  const t=c.orchestration,d=new Diagram(locale,'orchestration',t,30);let y=d.top;
  const shared=d.card(80,y,800,t.shared,{start:.01,end:.13,align:'middle'});y=shared.b+78;
  const pairs=[[t.ui,t.api],[t.waiting,t.progressing],[t.resume,t.done]],timing=[[[.13,.29],[.13,.29]],[[.3,.62],[.3,.53]],[[.63,.79],[.53,.82]]],nodes=[];let bottom=y;
  pairs.forEach((rows,r)=>{const h=Math.max(...rows.map((row,i)=>cardSize(row,404,{badge:r===1?(i?l.keepsWorking:l.waitOnly):undefined}))),pair=[];rows.forEach((row,i)=>{const x=i?500:56,[start,end]=timing[r][i];pair.push(d.card(x,y,404,row,{h,start,end,color:r===1&&!i?C.amber:i?C.teal:C.blue,progress:!(r===1&&!i),badge:r===1?(i?l.keepsWorking:l.waitOnly):undefined}));});nodes.push(pair);bottom=y+h;y=bottom+76;});
  d.wire(`M480 ${shared.b}V${nodes[0][0].y-36}H258V${nodes[0][0].y}`,.08,.15);d.wire(`M480 ${nodes[0][0].y-36}H702V${nodes[0][1].y}`,.08,.15,{color:C.teal});
  for(let r=0;r<2;r++)for(let i=0;i<2;i++)d.down(nodes[r][i],nodes[r+1][i],r===0?.25:i?.49:.59,r===0?.32:i?.55:.65,{color:i?C.teal:r===0?C.amber:C.blue});
  d.wire(`M258 ${bottom}V${y-36}H480V${y}`,.79,.86);d.wire(`M702 ${bottom}V${y-36}H480`,.79,.86,{color:C.teal,arrow:false});const merge=d.card(80,y,800,t.merge,{badge:l.join,start:.86,end:.96,color:C.teal,align:'middle'});out.orchestration=d.finish(merge.b);
 }
 {
  const t=c.rhythm,d=new Diagram(locale,'rhythm',{...t,sub:t.sub+' · '+l.alternatives},32);let y=d.top;
  const event=d.card(80,y,800,t.event,{start:.01,end:.12,progress:false,align:'middle'});y=event.b+80;
  const rows=t.rows.map(row=>[row[0],row[1]+' · '+row[2]]),hs=[0,1].map(i=>Math.max(...rows.slice(i*2,i*2+2).map(row=>cardSize(row,376)))),secondY=y+hs[0]+72,positions=[[72,y],[512,y],[72,secondY],[512,secondY]],colors=[C.muted,C.teal,C.blue,C.amber];
  positions.forEach(([x,yy],i)=>{const trunk=i<2?y-49:secondY-36,side=i%2?924:36,route=i<2?`M480 ${event.b}V${trunk}H${x+188}V${yy}`:`M480 ${event.b}V${y-61}H${side}V${trunk}H${x+188}V${yy}`;d.wire(route,.08+i*.13,.18+i*.13,{color:colors[i],transient:true});d.card(x,yy,376,rows[i],{h:hs[i>1?1:0],start:.12+i*.13,end:.24+i*.13,color:colors[i],progress:false});});
  y=secondY+hs[1]+74;d.label(l.pauseCondition,480,y,848,{size:30,line:39,weight:650,fill:C.purple,align:'middle'});y+=wrap(l.pauseCondition,848,30).length*39+28;
  const pause=d.card(80,y,800,t.pause,{badge:l.pauseInput,start:.68,end:.82,color:C.purple,progress:false,align:'middle'}),resume=d.card(80,pause.b+64,800,[l.resume,t.continue],{start:.83,end:.95,color:C.teal,align:'middle'});d.down(pause,resume,.79,.86,{color:C.purple});out.rhythm=d.finish(resume.b);
 }
 {
  const t=c.continuity,d=new Diagram(locale,'continuity',t);let y=d.top;
  const current=d.card(80,y,800,t.current,{start:.01,end:.15,align:'middle'});y=current.b+78;
  const left=[t.saved,t.resume,t.verify],right=[t.learning,[t.evaluate[0],l.evaluateEvidence],[l.writeback,t.evaluate[1]]];let prev;
  for(let r=0;r<3;r++){
   const pair=[left[r],right[r]],h=Math.max(...pair.map((row,i)=>cardSize(row,404,{badge:r===0?(i?l.reusable:l.currentTask):undefined}))),nodes=pair.map((row,i)=>d.card(i?500:56,y,404,row,{h,badge:r===0?(i?l.reusable:l.currentTask):undefined,start:.15+r*.2,end:.32+r*.2,color:i?C.purple:C.teal}));
   if(r===0){d.wire(`M480 ${current.b}V${y-36}H258V${y}`,.1,.18,{color:C.teal});d.wire(`M480 ${y-36}H702V${y}`,.1,.18,{color:C.purple});}else nodes.forEach((node,i)=>d.down(prev[i],node,.29+(r-1)*.2,.37+(r-1)*.2,{color:i?C.purple:C.teal}));prev=nodes;y+=h+74;
  }
  out.continuity=d.finish(y-74);
 }
 return out;
}
// Prepare every locale before writing: a layout error cannot leave partial output.
const outputs=Object.keys(copy).flatMap(locale=>Object.entries(diagrams(locale)).map(([id,svg])=>({name:`animated-${id}.${locale}.svg`,svg})));
if(!check)fs.mkdirSync(OUT,{recursive:true});
for(const{name,svg}of outputs){const file=path.join(OUT,name);if(check){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==svg)throw new Error(`Rebuild README animation: ${name}`);}else fs.writeFileSync(file,svg);}
console.log(`${check?'Checked':'Built'} ${outputs.length} localized README diagrams.`);
