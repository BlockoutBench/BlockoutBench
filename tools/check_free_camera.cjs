const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
(async () => {
  let browser;
  for (const channel of ['msedge','chrome',undefined]) {
    try { browser=await chromium.launch({channel,headless:true,args:['--enable-unsafe-swiftshader']}); break; } catch {}
  }
  if (!browser) throw new Error('Install Edge/Chrome or Playwright Chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('dialog', d=>d.dismiss());
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(__dirname, '../index.html')).href);
    await page.evaluate(() => { window.__workbench.loadMap('sample-multifloor'); window.__workbench.setMode('3d'); });
    await page.waitForFunction(() => window.__workbench.view3d.ready);
    const cam = () => page.evaluate(() => window.__workbench.view3d.camera);
    const same = (a,b) => a.every((n,i) => Math.abs(n-b[i]) < .001);
    const hold = async key => { await page.keyboard.down(key); await page.waitForTimeout(350); await page.keyboard.up(key); await page.waitForTimeout(80); };
    const result = {};
    for (const view of ['persp','iso']) {
      await page.click(view==='iso' ? '#viewIsoBtn' : '#viewPerspBtn');
      const box=await page.locator('#gl3d').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
      await page.mouse.move(x,y); await page.focus('#gl3d');
      const before=await cam(); await hold('w');
      // WASD moves on its own; the right button only looks around and steps the speed.
      const start=await cam();
      const check={ perspective:!before.ortho, movesWithoutRMB:!same(before.eye,start.eye) };
      await page.mouse.down({button:'right'});
      await page.mouse.move(x+80,y+45,{steps:6});
      let a=await cam(); check.look=Math.abs(a.yaw-start.yaw)>.1 && Math.abs(a.pitch-start.pitch)>.1 && same(a.eye,start.eye);
      await hold('w'); let b=await cam(); const v=b.eye.map((n,i)=>n-a.eye[i]),len=Math.hypot(...v);
      check.forward3D=len>1 && v.reduce((s,n,i)=>s+n*a.forward[i],0)/len>.999 && Math.abs(v[1])>.1;
      a=b; await hold('e'); b=await cam(); check.vertical=b.eye[1]>a.eye[1]+1 && Math.abs(b.eye[0]-a.eye[0])<.001;
      const level=await page.evaluate(()=>window.__workbench.view3d.fly.level);
      await page.mouse.wheel(0,-120); await page.waitForTimeout(100);
      check.speed=(await page.evaluate(()=>window.__workbench.view3d.fly.level))>level;
      await page.keyboard.down('w'); await page.waitForTimeout(150); await page.mouse.up({button:'right'}); await page.waitForTimeout(100);
      a=await cam(); await page.waitForTimeout(250); b=await cam(); check.keepsMovingAfterRMBUp=!same(a.eye,b.eye);
      await page.keyboard.up('w'); await page.waitForTimeout(80);
      a=await cam(); await page.waitForTimeout(250); check.keyUpStops=same(a.eye,(await cam()).eye);
      // Typing in a field must not fly the camera: focusing an input stops movement.
      await page.evaluate(()=>{ const d=document.querySelector('#outlineSearch')?.closest('details'); if(d) d.open=true; });
      await page.waitForTimeout(300);
      await page.keyboard.down('w'); await page.waitForTimeout(150);
      await page.focus('#outlineSearch');
      await page.waitForTimeout(100);
      a=await cam(); await page.waitForTimeout(250); check.typingStops=same(a.eye,(await cam()).eye) && await page.evaluate(()=>document.activeElement.id==='outlineSearch');
      await page.keyboard.up('w'); await page.fill('#outlineSearch',''); await page.focus('#gl3d');
      await page.click('#copyLinkBtn'); const poseBefore=await cam(); await page.reload(); await page.waitForFunction(()=>window.__workbench.view3d.ready); const restored=await cam(); check.poseRoundtrip=poseBefore.eye.every((n,i)=>Math.abs(n-restored.eye[i])<.02) && Math.abs(poseBefore.pitch-restored.pitch)<.001;
      result[view]=check;
    }
    result.errors=errors;
    fs.mkdirSync(path.join(__dirname,'out'),{recursive:true});
    fs.writeFileSync(path.join(__dirname,'out/free-camera-check.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    if(errors.length || Object.values(result).filter(v=>!Array.isArray(v)).some(v=>Object.values(v).some(x=>!x)))process.exitCode=1;
  } finally { await browser.close(); }
})();

