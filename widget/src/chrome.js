// Widget-only hover chrome over the dashboard. Visual only: clicks are hit-tested natively
// in main.rs, so the sizes here must match BAR, BTN, EDGE and BAR_MODE there, and the grip
// glyph must sit inside the GRIP hit square.
addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = `
    html { scrollbar-width: none }
    ::-webkit-scrollbar { display: none }
    #cession-chrome { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity .15s; color: #f0efec; font: 13px -apple-system, sans-serif; }
    html.cession-hover #cession-chrome { opacity: 1 }
    #cession-chrome .bar { position: absolute; top: 0; left: 0; right: 0; height: 24px; background: #000000b3; backdrop-filter: blur(10px); display: grid; place-items: center; color: #f0efec99; }
    #cession-chrome .btn { position: absolute; top: 0; width: 24px; height: 24px; display: grid; place-items: center; color: #f0efec; }
    #cession-chrome .grip { position: absolute; right: 3px; bottom: 3px; width: 14px; height: 14px; }
    @media (max-height: 60px) {
      #cession-chrome .bar { height: 100%; background: none; color: transparent; backdrop-filter: none; }
      #cession-chrome .btn { height: 100%; background: #000000b3; }
      #cession-chrome .grip { display: none }
    }
  `;
  const chrome = document.createElement("div");
  chrome.id = "cession-chrome";
  chrome.innerHTML = `
    <div class="bar">
      ⠿⠿⠿
      <div class="btn" style="right: 58px">↕</div>
      <div class="btn" style="right: 34px">⇥</div>
      <div class="btn" style="right: 10px">✕</div>
    </div>
    <svg class="grip" viewBox="0 0 14 14" stroke="#888" stroke-width="1.5" stroke-linecap="round"><path d="M13 5 5 13M13 9l-4 4"/></svg>`;
  document.head.append(style);
  document.body.append(chrome);
});
