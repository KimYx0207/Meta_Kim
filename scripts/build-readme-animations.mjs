#!/usr/bin/env node
/** Self-contained README diagrams. Rebuild with this script; --check is read-only.
 * Static text and paths explain the complete relationship. Animation adds a run:
 * outputs accumulate, independent lanes progress, failures return to their owners.
 * No scripts, remote assets, external fonts, foreignObject, or motion-only text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copy, diagramLabels, workContextCopy } from './readme-animation-copy.mjs';
import { architectureCopy, runtimeSelectionCopy, panoramaCopy } from './readme-architecture-copy.mjs';
import { projectCopy } from './readme-project-copy.mjs';
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
  const t=projectCopy[locale],d=new Diagram(locale,'project-specialization',t,24);
  const source=d.card(80,d.top,800,t.source,{start:.01,end:.18,progress:false,align:'middle',fill:'#eaf1ff'});
  const w=404,y=source.b+74,h=Math.max(...t.projects.map(row=>cardSize(row,w)));
  const ownerY=y+h+64,ownerH=Math.max(...t.owners.map(row=>cardSize(row,w)));
  t.projects.forEach((row,i)=>{
   const x=i?500:56,color=i?C.purple:C.teal;
   d.wire(`M480 ${source.b}V${y-34}H${x+w/2}V${y}`,.15,.3,{color});
   const project=d.card(x,y,w,row,{h,start:.28,end:.53,progress:false,color});
   const owner=d.card(x,ownerY,w,t.owners[i],{h:ownerH,start:.56,end:.92,progress:false,color});
   d.down(project,owner,.5,.61,{color});
  });
  out['project-specialization']=d.finish(ownerY+ownerH);
 }
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
 {
  const t=workContextCopy[locale],d=new Diagram(locale,'work-context',t,32);
  const host=d.card(80,d.top,800,t.host,{start:.01,end:.13,progress:false,align:'middle',fill:'#eaf1ff'});
  const y=host.b+82,w=404,h=Math.max(...t.runs.map(row=>cardSize(row,w)));
  const runs=t.runs.map((row,i)=>{
   const x=i?500:56;
   d.wire(`M480 ${host.b}V${y-38}H${x+w/2}V${y}`,.08+i*.12,.17+i*.12,{color:i?C.teal:C.blue});
   return d.card(x,y,w,row,{h,start:.13+i*.12,end:.29+i*.12,color:i?C.teal:C.blue});
  });
  const receiptY=y+h+84;
  runs.forEach((r,i)=>d.wire(`M${r.cx} ${r.b}V${receiptY-38}H480${i?'':`V${receiptY}`}`,.36,.43,{color:i?C.teal:C.blue,arrow:!i}));
  const receipt=d.card(80,receiptY,800,t.receipt,{start:.4,end:.49,progress:false,align:'middle'});
  const groupY=receipt.b+66,hs=[0,1].map(i=>Math.max(...t.states.slice(i*2,i*2+2).map(row=>cardSize(row,w))));
  const groupBottom=groupY+hs[0]+30+hs[1];
  d.parts.push(`<rect x="40" y="${groupY-16}" width="880" height="${groupBottom-groupY+32}" rx="25" fill="#edf3fa" stroke="#cbd9e9"/>`);
  d.wire(`M480 ${receipt.b}V${groupY-16}`,.45,.5);
  t.states.forEach((row,i)=>d.card(i%2?500:56,groupY+(i>1?hs[0]+30:0),w,row,{h:hs[i>1?1:0],start:.49+i*.075,end:.59+i*.075,progress:false,color:[C.blue,C.teal,C.purple,C.amber][i]}));
  const candidateY=groupBottom+88;
  d.wire(`M480 ${groupBottom+16}V${candidateY}`,.79,.85,{color:C.purple});
  const candidate=d.card(80,candidateY,800,t.candidate,{start:.84,end:.96,progress:false,color:C.purple,align:'middle'});
  out['work-context']=d.finish(candidate.b);
 }
 {
  const t=architectureCopy[locale],d=new Diagram(locale,'layers',t,32);
  const source=d.card(80,d.top,800,t.source,{start:.01,end:.13,progress:false,align:'middle',fill:'#eaf1ff'});
  const app=d.card(80,source.b+76,800,t.application,{start:.14,end:.28,progress:false,align:'middle'});
  d.down(source,app,.09,.17);
  const y=app.b+112,w=392,h=Math.max(cardSize(t.data,w),cardSize(t.adapter,w));
  const data={x:64,y,w,h,cx:260,b:y+h},adapter={x:504,y,w,h,cx:700,b:y+h};
  d.wire(`M700 ${app.b}V${y}`,.25,.35,{color:C.purple});
  d.wire(`M896 ${y+h/2}H930V${app.y+app.h/2}H880`,.41,.55,{color:C.purple,back:true});
  d.wire(`M260 ${app.b}V${y}`,.56,.65,{color:C.teal});
  d.label(t.result,480,app.b+59,360,{size:26,line:34,fill:C.purple,align:'middle'});
  d.card(data.x,y,w,t.data,{h,start:.61,end:.76,progress:false,color:C.teal});
  d.card(adapter.x,y,w,t.adapter,{h,start:.31,end:.48,progress:false,color:C.purple});
  const presentation=d.card(80,y+h+94,800,t.presentation,{start:.78,end:.95,progress:false,color:C.teal,align:'middle',fill:'#edf8f6'});
  d.wire(`M260 ${data.b}V${presentation.y-42}H480V${presentation.y}`,.72,.83,{color:C.teal});
  out.layers=d.finish(presentation.b);
 }
 {
  const t=runtimeSelectionCopy[locale],d=new Diagram(locale,'runtime-selection',t,30);
  const task=d.card(80,d.top,800,t.task,{start:.01,end:.12,progress:false,align:'middle',fill:'#eaf1ff'});
  const w=404,choiceY=task.b+78,choiceH=Math.max(...t.choices.map(row=>cardSize(row,w)));
  const checkY=choiceY+choiceH+78,checkH=Math.max(...t.checks.map(row=>cardSize(row,w)));
  const checks=[];
  t.choices.forEach((row,i)=>{
   const x=i?500:56,color=i?C.purple:C.blue;
   d.wire(`M480 ${task.b}V${choiceY-38}H${x+w/2}V${choiceY}`,.08,.17,{color});
   const choice=d.card(x,choiceY,w,row,{h:choiceH,start:.14,end:.36,progress:false,color});
   const check=d.card(x,checkY,w,t.checks[i],{h:checkH,start:.4,end:.64,progress:false,color});
   d.down(choice,check,.32,.45,{color});checks.push(check);
  });
  const receiptY=checkY+checkH+94;
  checks.forEach((n,i)=>d.wire(`M${n.cx} ${n.b}V${receiptY-42}H480${i?'':`V${receiptY}`}`,.63,.77,{color:i?C.purple:C.blue,arrow:!i}));
  const receipt=d.card(80,receiptY,800,t.receipt,{start:.77,end:.96,progress:false,color:C.teal,align:'middle',fill:'#edf8f6'});
  out['runtime-selection']=d.finish(receipt.b);
 }
 return out;
}
// Generate the expanded walkthrough under its own filename. The original wide
// system panorama is an independent, preserved source diagram.
function systemPanorama(locale){
 const t=panoramaCopy[locale],d=new Diagram(locale,'system-panorama',t,36);
 const x=56,w=848,pairW=400,px=[56,504];
 function box(row,xx,y,ww,{color=C.blue,fill='#fff',start=.01,end=.1,h:fixedH}={}){
  const titleRows=wrap(row[0],ww-48,32),bodyRows=wrap(row[1],ww-48,29);
  const h=fixedH??(26+titleRows.length*41+12+bodyRows.length*38+24);
  const focus=d.focus(start,end);
  d.parts.push(`<g class="node" data-label="${esc(row[0])}" data-box="${xx},${y},${ww},${h}"><rect x="${xx}" y="${y}" width="${ww}" height="${h}" rx="20" fill="${fill}" stroke="${C.line}" stroke-width="1.5"/><rect class="focus ${focus}" x="${xx}" y="${y}" width="${ww}" height="${h}" rx="20" fill="${color}" fill-opacity=".045" stroke="${color}" stroke-width="3"/>${text(row[0],xx+24,y+54,ww-48,{size:32,line:41,weight:700,fill:color})}${text(row[1],xx+24,y+54+titleRows.length*41+10,ww-48,{size:29,line:38,fill:C.muted})}</g>`);
  return {x:xx,y,w:ww,h,cx:xx+ww/2,b:y+h};
 }
 const height=(row,ww)=>26+wrap(row[0],ww-48,32).length*41+12+wrap(row[1],ww-48,29).length*38+24;
 function section(i,y){
  d.parts.push(`<circle cx="28" cy="${y-10}" r="7" fill="${C.blue}"/>`);
  return y+d.label(`${String(i+1).padStart(2,'0')}  ${t.sections[i]}`,x,y,w,{size:29,line:38,weight:700,fill:C.blue})+22;
 }
 function pair(rows,y,start,end,colors=[C.blue,C.teal]){
  const h=Math.max(...rows.map(row=>height(row,pairW)));
  return rows.map((row,i)=>box(row,px[i],y,pairW,{h,color:colors[i],start,end}));
 }
 function fork(source,nodes,start,end){
  const junction=nodes[0].y-27;
  nodes.forEach((node,i)=>d.wire(`M${source.cx} ${source.b}V${junction}H${node.cx}V${node.y}`,start,end,{color:i?C.teal:C.blue}));
 }
 function join(nodes,target,start,end){
  const junction=target.y-28;
  nodes.forEach((node,i)=>d.wire(`M${node.cx} ${node.b}V${junction}H${target.cx}${i?'':`V${target.y}`}`,start,end,{color:i?C.teal:C.blue,arrow:!i}));
 }
 const live=box(t.live,x,d.top,w,{fill:'#eaf1ff',start:.01,end:.99});
 const railTop=live.b+42;
 let y=section(0,live.b+78);
 const intent=box(t.intent,x,y,w,{start:.02,end:.1});
 const research=pair(t.research,intent.b+66,.11,.23);
 fork(intent,research,.08,.14);
 y=section(1,research[0].b+94);
 const compare=box(t.compare,x,y,w,{start:.24,end:.36});
 join(research,{cx:480,y:research[0].b+58},.19,.27);
 const choices=pair(t.choices,compare.b+66,.37,.46,[C.teal,C.amber]);
 fork(compare,choices,.34,.4);
 y=section(2,choices[0].b+94);
 y+=d.label(t.samePrd,480,y,w,{size:28,line:37,weight:650,fill:C.muted,align:'middle'})+18;
 const prdY=y,prdH=Math.max(...t.prd.map(row=>height(row,pairW)));
 const system=box(t.prd[0],px[0],prdY,pairW,{h:prdH,start:.49,end:.56,fill:'#eef4ff'});
 const module=box(t.prd[1],px[1],prdY,pairW,{h:prdH,start:.57,end:.64,fill:'#eef4ff'});
 // Both decision paths return to one baseline. Connectors stop before section
 // headings so the arrows never run through the translated labels.
 join(choices,{cx:480,y:choices[0].b+58},.44,.5);
 d.wire(`M${system.x+system.w} ${system.y+system.h/2}H${module.x}`, .54,.6);
 const capabilities=box(t.capabilities,x,system.b+66,w,{start:.65,end:.74,color:C.purple});
 d.wire(`M${module.cx} ${module.b}V${capabilities.y-28}H480V${capabilities.y}`,.62,.67,{color:C.purple});
 y=section(3,capabilities.b+94);
 const ready=pair(t.ready,y,.75,.83);
 d.down(capabilities,{cx:480,y:capabilities.b+58},.71,.76,{color:C.purple});
 const dependency=box(t.dependency,x,ready[0].b+66,w,{start:.82,end:.87,color:C.teal});
 join(ready,dependency,.79,.84);
 y=section(4,dependency.b+94);
 const verification=box(t.verification,x,y,w,{start:.87,end:.93,color:C.teal});
 d.down(dependency,{cx:480,y:dependency.b+58},.85,.89,{color:C.teal});
 const revisionY=verification.b+52;
 const revisionH=d.label(t.revision,480,revisionY,800,{size:28,line:37,fill:C.purple,weight:650,align:'middle'});
 // Revision goes back to the affected task. Facts and design changes use the
 // same scoped-return rule stated in the adjacent, always-visible caption.
 d.wire(`M${verification.x+verification.w} ${verification.y+verification.h/2}H932V${ready[1].y+ready[1].h/2}H${ready[1].x+ready[1].w}`,.9,.95,{color:C.purple,back:true,transient:true});
 const delivery=box(t.delivery,x,revisionY+revisionH+48,w,{start:.94,end:.99,fill:'#edf8f6',color:C.teal});
 // Keep the delivery connector outside the revision caption's text column.
 d.wire(`M${verification.cx} ${verification.b}V${verification.b+22}H44V${delivery.y-24}H480V${delivery.y}`,.93,.98,{color:C.teal});
 d.label(t.passed,250,delivery.y-34,360,{size:28,line:37,fill:C.teal,weight:700,align:'middle'});
 d.parts.unshift(`<path d="M28 ${railTop}V${delivery.b}" fill="none" stroke="#c9d8f0" stroke-width="3" stroke-dasharray="5 10"/>`);
 return d.finish(delivery.b);
}
// Prepare every locale before writing: a layout error cannot leave partial output.
const outputs=Object.keys(copy).flatMap(locale=>[
 ...Object.entries(diagrams(locale)).map(([id,svg])=>({name:`animated-${id}.${locale}.svg`,svg})),
 {name:`research-to-delivery.${locale}.svg`,svg:systemPanorama(locale)},
]);
if(!check)fs.mkdirSync(OUT,{recursive:true});
for(const{name,svg}of outputs){const file=path.join(OUT,name);if(check){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==svg)throw new Error(`Rebuild README animation: ${name}`);}else fs.writeFileSync(file,svg);}
console.log(`${check?'Checked':'Built'} ${outputs.length} localized README diagrams.`);
