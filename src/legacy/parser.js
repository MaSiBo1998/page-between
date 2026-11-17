import * as C from './core.js';
  'use strict';

  const contentSelectors=['#content','#chaptercontent','#chapter-content','#chapterContent','#ChapterBody','.read-content','.readContent','.chapter-content','.chapter_content','.content_read','.reading-content','.reader-content .content','.reader-content','.readerContent','.bookreadercontent','.book-content','.read-body','.read_chapterDetail','.read-txt','.noveltext','.read-bd','.txtnav','.article-content','.entry-content','article'];
  const catalogSelectors=['#list','#listmain','.listmain','.chapter-list','.chapterlist','.chapter_list','.catalog-list','.catalog-content','.catalog-content-wrap','.volume-list','.book_catalog','.book-mulu','.mulu','.book-chapter-list','.book_list','dl'];
  function nodes(doc,selector){try{return [...doc.querySelectorAll(selector)];}catch{throw Error('CSS 选择器有误：'+selector);}}
  function links(doc,selector,base){
    return nodes(doc,selector).map(a=>{try{return {node:a,title:C.clean(a.textContent),url:C.url(a.getAttribute('href'),base)};}catch{return null;}}).filter(Boolean);
  }
  function text(node,remove=''){
    const n=node.cloneNode(true);
    nodes(n,'script,style,noscript,iframe,ins,button,input,select,nav,footer,header,.ads,.ad,.advertisement,.read-ad,.recommend,.toolbar,.reader-tools,.book-fix,.chapter-control').forEach(e=>e.remove());
    if(remove)nodes(n,remove).forEach(e=>e.remove());
    nodes(n,'br').forEach(e=>e.replaceWith('\n'));
    nodes(n,'p,div,section,li').forEach(e=>e.append('\n'));
    return C.clean(n.textContent).split('\n').map(s=>s.trim()).filter((s,i,a)=>s||a[i-1]).join('\n').replace(/\n{3,}/g,'\n\n');
  }
  function pageLinks(doc,base,selector,regexp){
    const found=links(doc,selector||'a[href]',base).filter(a=>selector||regexp.test(a.title.replace(/\s/g,'')));
    return found.filter(a=>C.allowed(a.url,base)).at(-1)?.url||null;
  }
  function catalog(doc,base,rules={}){
    let selected=[],used='';
    const candidates=rules.catalog?[rules.catalog]:catalogSelectors;
    for(const selector of candidates){
      const list=links(doc,rules.catalog?selector:selector+' a[href]',base).filter(a=>a.url!==C.url(base)&&C.allowed(a.url,base)&&(rules.catalog||C.chapterPattern.test(a.title)));
      if(list.length>selected.length){selected=list;used=selector;}
    }
    if(!selected.length&&!rules.catalog){selected=links(doc,'a[href]',base).filter(a=>C.chapterPattern.test(a.title)&&C.allowed(a.url,base));used='全页章节链接';}
    const seen=new Set();selected=selected.filter(a=>{if(!a.title||a.title.length>180||seen.has(a.url))return false;seen.add(a.url);return true;});
    if(!selected.length)throw Error('没有识别到目录。请展开全部章节后重试，或填写“目录链接选择器”。');
    // A mixed latest-chapters block is sorted by chapter numbers only when every number is Arabic and unique.
    const number=s=>{const m=s.match(/(?:第\s*(\d+)\s*[章节回话]|chapter\s+(\d+))/i);return m?+(m[1]||m[2]):null;};
    const nums=selected.map(a=>number(a.title));
    let sorted=false;
    if(nums.every(n=>n!==null)&&new Set(nums).size===nums.length){selected.sort((a,b)=>number(a.title)-number(b.title));sorted=true;}
    if(!sorted&&rules.reverse)selected.reverse();
    const titleNode=rules.bookTitle?nodes(doc,rules.bookTitle)[0]:doc.querySelector('meta[property="og:novel:book_name"],meta[property="og:book:name"],h1');
    const title=C.clean(titleNode?.getAttribute('content')||titleNode?.textContent||doc.title.replace(/[_|｜].*$/,'')).replace(/(?:最新章节.*|章节目录.*)$/,'').trim();
    return {kind:'catalog',title,catalog:selected.map(({title,url})=>({title,url})),selector:used,next:pageLinks(doc,base,rules.catalogNext,/^(?:下一页|下页|下一目录页|下[一]?页目录)[»›→>]*$/),url:C.url(base)};
  }
  function chapter(doc,base,rules={}){
    if(doc.querySelector('[data-vip="1"]')&&doc.querySelector('.reader-app-download.Jfandaoban'))throw Error('当前网页返回 VIP 试读及客户端阅读提示，未计为完整章节。');
    if(doc.querySelector('.vip-preview')||nodes(doc,'.pay-section,.reader-app-download.Jfandaoban,.book-read .btn-login').some(n=>n.textContent.match(/登录订阅本章|看全文|继续阅读|订阅|下载|登录|付费阅读/)))throw Error('当前网页只返回试读片段，需要正常订阅或客户端阅读，未计为完整章节。');
    const titleNode=rules.chapterTitle?nodes(doc,rules.chapterTitle)[0]:['.j_chapterName','.muye-reader-title','.chapter-title','.reader-title','.bookname h1','.reader-content .title','.read-hd h1','.chapter h3','h1','h2','h3'].map(s=>doc.querySelector(s)).find(Boolean);
    const rawTitle=C.clean(titleNode?.textContent||'');
    let best=null;
    for(const selector of rules.content?[rules.content]:contentSelectors){
      for(const n of nodes(doc,selector)){
        const t=text(n,rules.remove);
        const linkText=[...n.querySelectorAll('a')].reduce((sum,a)=>sum+a.textContent.length,0);
        const score=t.length-linkText*3;
        if(t.length>=10&&(!best||score>best.score))best={text:t,selector,score};
      }
      if(best)break;
    }
    if(!best)throw Error('没有识别到可下载的正文。可设置正文选择器；动态加载正文需要站点专用适配。');
    let next=pageLinks(doc,base,rules.next,/^(?:下一页|下页)[»›→>]*$/)||pageLinks(doc,base,rules.next,/^(?:下一章|下章|下一节|nextchapter|next)[»›→>]*$/i);
    if(new URL(base).hostname.endsWith('17k.com')&&next&&/\/0\.html$/.test(new URL(next).pathname))next=null;
    if(!rawTitle)throw Error('没有识别到章节标题，请填写“章节标题选择器”。');
    const blocked=best.text.match(/(?:本章为VIP|本章节为付费|本章需.{0,6}订阅|订阅本章|购买本章|请先登录.{0,8}(?:阅读|查看)|请输入.{0,6}验证码|访问过于频繁|请完成.{0,8}验证|请拖动.{0,8}滑块)/);
    if(blocked)throw Error('当前正文含访问或订阅提示：'+blocked[0]+'。请在网站完成正常访问后重试。');
    return {kind:'chapter',url:C.url(base),rawTitle,title:C.heading(rawTitle).title,text:best.text,selector:best.selector,next};
  }
  function decode(buffer,headers=''){
    const bytes=new Uint8Array(buffer),preview=new TextDecoder('latin1').decode(bytes.subarray(0,8192));
    let charset=headers.match(/content-type:[^\r\n]*charset\s*=\s*["']?([^\s;"']+)/i)?.[1]||preview.match(/charset\s*=\s*["']?([^\s;"'/>]+)/i)?.[1]||'utf-8';
    if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)charset='utf-8';
    const html=new TextDecoder(charset).decode(bytes);
    return new DOMParser().parseFromString(html,'text/html');
  }
export {catalog,chapter,decode,text,contentSelectors,catalogSelectors};
