import fs from 'node:fs';
import { chromium } from '../frontend/node_modules/@playwright/test/index.mjs';

// Against a real running server; does not create downloads or modify settings.
const base = process.env.DOWNKYI_CHECK_URL || 'http://127.0.0.1:8511';
const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox']});
const directory = '/tmp/downkyi-live-screenshots';
fs.mkdirSync(directory, {recursive:true});
const results=[];
try {
  for (const width of [1440, 390, 320]) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
    const session = await (await context.request.get(base+'/api/session')).json();
    const authRequired = session.auth_required !== false;
    await page.goto(base);
    if (authRequired) {
      const token = process.env.DOWNKYI_CHECK_TOKEN || fs.readFileSync(new URL('../data/admin-token', import.meta.url), 'utf8').trim();
      await page.getByRole('heading',{name:'登录下载工作台',exact:true}).waitFor();
      await page.screenshot({path:`${directory}/login-${width}.png`,fullPage:true});
      await page.getByLabel('访问令牌',{exact:true}).fill(token);
      await page.getByRole('button',{name:'登录',exact:true}).click();
    } else {
      await page.getByText('免令牌',{exact:true}).waitFor();
      if (await page.getByRole('button',{name:'退出登录',exact:true}).count()) throw Error('Logout must be hidden without authentication');
      if ((await context.cookies()).some(cookie=>cookie.name==='downkyi_session')) throw Error('No-token mode must not require a session cookie');
      await page.reload();
    }
    await page.getByRole('heading',{name:/^下载队列/}).waitFor();
    await page.getByText('服务已连接',{exact:true}).waitFor();
    if(await page.evaluate(()=>document.cookie.includes('downkyi_session')))throw Error('Session must be HttpOnly');
    if(!await page.locator('.variant-B').count())throw Error('Wrong approved layout');
    await page.screenshot({path:`${directory}/queue-${width}.png`,fullPage:true});
    async function navigate(label) {
      if(await page.getByRole('button',{name:'打开导航',exact:true}).isVisible())await page.getByRole('button',{name:'打开导航',exact:true}).click();
      await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:new RegExp(`^${label}`)}).click();
    }
    await navigate('服务器');
    await page.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();
    await page.screenshot({path:`${directory}/system-${width}.png`,fullPage:true});
    await navigate('偏好设置');
    await page.getByRole('heading',{name:'偏好设置',exact:true}).waitFor();
    await page.getByLabel('下载目录',{exact:true}).waitFor();
    if(!(await page.getByLabel('下载目录',{exact:true}).inputValue()).startsWith('/'))throw Error('Missing configured download directory');
    await page.screenshot({path:`${directory}/settings-${width}.png`,fullPage:true});
    await navigate('下载队列');
    await page.getByRole('button',{name:'新建下载',exact:true}).first().click();
    await page.getByLabel('视频、合集、番剧链接或 BV / AV 号',{exact:true}).fill('https://www.bilibili.com/video/BV1bK411W797?p=1');
    await page.getByRole('button',{name:'解析',exact:true}).click();
    await page.getByRole('heading',{name:'下载规格',exact:true}).waitFor({timeout:190000});
    await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0),{timeout:30000});
    await page.screenshot({path:`${directory}/parse-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'确认规格',exact:true}).click();
    await page.screenshot({path:`${directory}/review-${width}.png`,fullPage:true});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    if(overflow)throw Error(`Page overflow at ${width}`);
    if(errors.length)throw Error(errors.join('\n'));
    results.push({width,authRequired,realServer:true,realParse:true,errors:0});
    await context.close();
  }
  console.log(JSON.stringify({results,screenshots:directory},null,2));
} finally {await browser.close();}
