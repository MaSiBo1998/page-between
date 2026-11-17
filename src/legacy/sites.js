  // Research targets, not a claim that every chapter on every platform is supported.
  const sites=[
    ['起点中文网','qidian.com','https://www.qidian.com/',{content:'.read-content',chapterTitle:'.j_chapterName',next:'#j_chapterNext'}],
    ['纵横中文网','zongheng.com','https://www.zongheng.com/',{content:'.reader-content .content',chapterTitle:'.title_txtbox',catalog:'.chapter-list a[href],.chapter-list-item a[href]'}],
    ['17K小说网','17k.com','https://www.17k.com/',{content:'.readAreaBox .p',chapterTitle:'.readArea h1,.read_tit h1'}],
    ['晋江文学城','jjwxc.net','https://www.jjwxc.net/',{content:'.noveltext',chapterTitle:'.noveltitle'}],
    ['长佩文学','gongzicp.com','https://www.gongzicp.com/',{}],
    ['番茄小说','fanqienovel.com','https://fanqienovel.com/',{content:'.muye-reader-content',chapterTitle:'.muye-reader-title',catalog:'.chapter-item a[href]'}],
    ['七猫中文网','qimao.com','https://www.qimao.com/',{}],
    ['书旗小说','shuqi.com','https://www.shuqi.com/',{}],
    ['QQ阅读','book.qq.com','https://book.qq.com/',{content:'.chapter-content',chapterTitle:'.chapter-title'}],
    ['潇湘书院','xxsy.net','https://www.xxsy.net/',{content:'.reader-content .content',chapterTitle:'.reader-content h1'}],
    ['红袖添香','hongxiu.com','https://www.hongxiu.com/',{content:'.read-content',chapterTitle:'.j_chapterName',next:'#j_chapterNext',catalog:'.volume-wrap a[href]'}],
    ['小说阅读网','readnovel.com','https://www.readnovel.com/',{content:'.read-content',chapterTitle:'.j_chapterName',next:'#j_chapterNext',catalog:'.volume-wrap a[href]'}],
    ['言情小说吧','xs8.cn','https://www.xs8.cn/',{content:'.read-content',chapterTitle:'.j_chapterName',next:'#j_chapterNext',catalog:'.volume-wrap a[href]'}],
    ['飞卢小说网','faloo.com','https://b.faloo.com/',{}],
    ['刺猬猫阅读','ciweimao.com','https://www.ciweimao.com/',{content:'.read-bd',chapterTitle:'.read-hd h1'}],
    ['SF轻小说','sfacg.com','https://book.sfacg.com/',{content:'#ChapterBody',chapterTitle:'.article-title,h1'}],
    ['黑岩阅读','heiyan.com','https://www.heiyan.com/',{}],
    ['若初文学','ruochu.com','https://www.ruochu.com/',{content:'.page-content',chapterTitle:'h2'}],
    ['掌阅','ireader.com','https://www.ireader.com/',{}],
    ['逐浪小说网','zhulang.com','https://www.zhulang.com/',{}],
    ['三福小说','3fu.net','https://www.3fu.net/',{catalog:'#list a[href]',content:'#content',chapterTitle:'h1'}]
  ].map(([name,domain,url,hints])=>({name,domain,url,hints}));
  function find(host){return sites.find(s=>host===s.domain||host.endsWith('.'+s.domain));}
export {sites,find};
