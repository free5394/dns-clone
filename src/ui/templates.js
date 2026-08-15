// templates.js — UI 模板函数（阶段 E 从 index.legacy.js 拆出）
// 纯 JS 文件（tsc 不参与）：内含大量浏览器端 JS 模板字符串

// HTML 实体转义：所有插值到模板字符串的用户控制字段必须经过 escapeHtml
// 防止存储型 XSS（攻击者写入恶意 notes/target_domain 等字段即可在所有访客浏览器执行）
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * 渲染公共 HTML 骨架（DOCTYPE + PicoCSS + FontAwesome + 全局 CSS 变量）
 * 所有动态值在调用方传入前已经过 escapeHtml；本函数只做字符串拼接。
 */
export function getHtmlLayout(title, content) { return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"><style>
:root {
    --sidebar-width: 250px;
    --pico-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --pico-font-size: 16px;
    --pico-line-height: 1.6;
    --pico-border-radius: 12px;
    --pico-form-element-spacing-vertical: 1rem;
    --pico-form-element-spacing-horizontal: 1.25rem;
    --pico-shadow-sm: 0 2px 4px rgba(0,0,0,0.05);
    --pico-shadow-md: 0 4px 12px rgba(0,0,0,0.1);
    --pico-shadow-lg: 0 10px 30px rgba(0,0,0,0.1);
    --c-primary: #007aff;
    --c-primary-hover: #0056b3;
    --c-bg: #f0f2f5;
    --c-bg-blur: rgba(248, 249, 250, 0.7);
    --c-card-bg: rgba(255, 255, 255, 0.6);
    --c-card-border: rgba(255, 255, 255, 0.9);
    --c-text: #212529;
    --c-text-muted: #6c757d;
    --c-text-accent: var(--c-primary);
    --c-icon-bg: #e9ecef;
    --c-button-bg: var(--c-primary);
    --c-button-text: #ffffff;
    --noise-bg: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(%23n)" opacity="0.1"/></svg>');
}
html.dark {
    --c-primary: #0a84ff;
    --c-primary-hover: #409cff;
    --c-bg: #121212;
    --c-bg-blur: rgba(29, 29, 31, 0.7);
    --c-card-bg: rgba(29, 29, 31, 0.5);
    --c-card-border: rgba(255, 255, 255, 0.1);
    --c-text: #e5e5e7;
    --c-text-muted: #8e8e93;
    --c-text-accent: var(--c-primary);
    --c-icon-bg: #3a3a3c;
    --c-button-bg: var(--c-primary);
}
body {
    font-family: var(--pico-font-family);
    margin: 0;
    background-color: var(--c-bg);
    color: var(--c-text);
    transition: background-color 0.3s ease, color 0.3s ease;
    overflow-x: hidden;
}
.public-body-wrapper {
    position: relative;
    z-index: 1;
    width: 100%;
    min-height: 100vh;
}
.background-blurs {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    overflow: hidden;
    z-index: 0;
}
.background-blurs::before {
    content: '';
    position: absolute;
    width: 100%;
    height: 100%;
    background: var(--noise-bg);
}
.blur-orb {
    position: absolute;
    border-radius: 50%;
    filter: blur(100px);
    opacity: 0.2;
    animation: move 20s infinite alternate;
}
.blur-orb-1 {
    width: 500px; height: 500px;
    top: 10%; left: 10%;
    background-color: #007aff;
}
.blur-orb-2 {
    width: 400px; height: 400px;
    bottom: 10%; right: 10%;
    background-color: #ff3b30;
    animation-delay: -10s;
}
@keyframes move {
    from { transform: translate(-50px, -50px) rotate(0deg); }
    to { transform: translate(50px, 50px) rotate(360deg); }
}
main.container { max-width: none; padding: 0; display: flex; }
.auth-container {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 100vh;
    padding: 2rem;
}
.auth-container > article { width: 100%; max-width: 480px; }
.sidebar { width: var(--sidebar-width); flex-shrink: 0; background: var(--pico-card-background-color); height: 100vh; position: sticky; top: 0; border-right: 1px solid var(--pico-card-border-color); display: flex; flex-direction: column; }
.sidebar-header { padding: 1.5rem; text-align: left; border-bottom: 1px solid var(--pico-card-border-color); }
.sidebar-header h3 { margin: 0; font-size: 1.75rem; font-weight: 700; color: var(--pico-primary); }
.sidebar-nav { padding: 1rem 0; flex-grow: 1; }
.sidebar-nav a { display: flex; align-items: center; gap: .85rem; padding: .85rem 1.5rem; color: #495057; text-decoration: none; margin: 0 .75rem; border-radius: 6px; transition: background-color .2s ease, color .2s ease; font-weight: 500; }
.sidebar-nav a:hover { background: #e9ecef; color: #212529; }
.sidebar-nav a.active { color: #fff; background-color: var(--pico-primary); font-weight: 600; }
.main-content { flex-grow: 1; padding: 2.5rem; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
.page-header h2 { margin: 0; font-size: 2rem; font-weight: 700; }
.page { display: none; }
.page.active { display: block; animation: fadeIn .3s ease-out forwards; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
article, fieldset { border-radius: var(--pico-border-radius); border: 1px solid var(--pico-card-border-color); background: var(--pico-card-background-color); box-shadow: var(--pico-shadow-sm); padding: 2rem; }
dialog article { box-shadow: var(--pico-shadow-lg); }
legend { font-size: 1.25rem; font-weight: 600; padding: 0 .5rem; }
.domain-card { background-color: var(--pico-card-background-color); border: 1px solid var(--pico-card-border-color); border-radius: var(--pico-border-radius); padding: 1.5rem; display: grid; grid-template-columns: 2fr 1.5fr 1fr auto; gap: 1.5rem; align-items: center; transition: box-shadow .2s ease, transform .2s ease; margin-bottom: 1rem; }
.card-col { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.card-col strong { font-size: 0.75rem; color: #6c757d; margin-bottom: .25rem; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }
.card-col .domain-cell { font-size: 1rem; font-weight: 500; color: #212529; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.card-col small.domain-cell { color: #6c757d; font-weight: 400; }
.card-actions { display: flex; justify-content: flex-end; gap: .5rem; }
.record-details summary { display: inline-flex; align-items: center; cursor: pointer; user-select: none; list-style: none; font-weight: 500; }
.record-details ul { margin: 8px 0 0; padding-left: 20px; font-size: 0.9em; }
.status-success { color: #198754; } .status-failed { color: #dc3545; } .status-no_change { color: #6c757d; }
.notifications, .home-toast { z-index: 1050; }
.public-nav {
    position: sticky;
    top: 1rem;
    max-width: 1200px;
    margin: 0 auto 2rem auto;
    padding: 0.75rem 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--c-bg-blur);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid var(--c-card-border);
    border-radius: var(--pico-border-radius);
    box-shadow: var(--pico-shadow-md);
    z-index: 100;
}
.public-nav-title { font-size: 1.25rem; font-weight: 600; color: var(--c-text); }
.public-nav-actions { display: flex; align-items: center; gap: 1rem; }
.public-nav-actions a, .public-nav-actions button {
    text-decoration: none;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    font-weight: 500;
    transition: all 0.2s ease;
    border: none;
}
.public-nav-actions a { background-color: var(--c-button-bg); color: var(--c-button-text); }
.public-nav-actions a:hover { filter: brightness(1.1); }
#theme-toggle { background: var(--c-icon-bg); color: var(--c-text); font-size: 1.2rem; width: 40px; height: 40px; display:flex; align-items:center; justify-content:center; }
.public-container { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
.public-section h2 { font-size: 1.75rem; margin-bottom: 2rem; display: flex; align-items: center; gap: 0.75rem; color: var(--c-text); border: none; padding: 0;}
.public-section h2::before { content: ''; display: block; width: 5px; height: 1.25rem; background-color: var(--c-primary); border-radius: 3px; }
.public-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem; }
.public-card {
    background: var(--c-card-bg);
    backdrop-filter: blur(5px);
    -webkit-backdrop-filter: blur(5px);
    border: 1px solid var(--c-card-border);
    border-radius: var(--pico-border-radius);
    box-shadow: var(--pico-shadow-md);
    padding: 1.5rem;
    cursor: pointer;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
.public-card:hover { transform: translateY(-5px); box-shadow: var(--pico-shadow-lg); }
.public-card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.public-card-title { font-size: 1.1rem; font-weight: 600; color: var(--c-text); margin: 0; }
.public-card-meta { font-size: 0.8rem; color: var(--c-text-muted); white-space: nowrap; }
.public-card-content { font-family: "SF Mono", "Consolas", "Menlo", monospace; font-size: 1rem; color: var(--c-text-accent); word-break: break-all; }
.public-card-footer { font-size: 0.85rem; color: var(--c-text-muted); display: flex; align-items: center; gap: 0.5rem; }
.home-toast { position: fixed; top: 80px; right: 20px; background-color: var(--c-primary); color: #fff; padding: 12px 20px; border-radius: 6px; z-index: 1000; font-weight: 500; box-shadow: var(--pico-shadow-lg); transition: transform 0.4s ease-in-out, opacity 0.4s ease-in-out; transform: translateY(-100px); opacity: 0; }
.home-toast.show { transform: translateY(0); opacity: 1; }
.home-toast.hide { transform: translateY(50px); opacity: 0; }

@media (max-width: 768px) {
    .public-nav { top: 0; left: 0; right: 0; border-radius: 0; width: 100%; }
    .public-container { padding: 1rem; }
    .public-grid { grid-template-columns: 1fr; }
    main.container {
        display: block;
    }
    .sidebar {
        width: 100%;
        height: auto;
        position: static;
        border-right: none;
        border-bottom: 1px solid var(--pico-card-border-color);
    }
    .main-content {
        padding: 1.5rem 1rem;
    }
    .page-header {
        flex-direction: column;
        gap: 1rem;
        align-items: flex-start;
    }
    .page-header h2 {
        font-size: 1.75rem;
    }
    .domain-card {
        grid-template-columns: 1fr;
        gap: 1rem;
        padding: 1rem;
    }
    .card-actions {
        flex-direction: row;
        justify-content: flex-start;
        flex-wrap: wrap;
    }
}
</style></head><body><main class="container">${content}</main><div id="notifications" class="notifications"></div></body></html>`; }

export function getSetupPage() { return `<div class="auth-container"><article id="setupForm"><h1>系统初始化</h1><p>请设置一个安全的管理员密码以保护您的应用。</p><form><label for="password">管理员密码 (最少8位)</label><input type="password" id="password" required minlength="8"><button type="submit">设置密码</button></form><p id="error-msg" style="color:red"></p></article></div><script>document.querySelector('#setupForm form').addEventListener('submit',async function(e){e.preventDefault();const password=document.getElementById('password').value;document.getElementById('error-msg').textContent='';try{const res=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(!res.ok){const err=await res.json();throw new Error(err.error||'设置失败')}alert('设置成功，页面即将刷新...');setTimeout(()=>window.location.reload(),1000)}catch(e){document.getElementById('error-msg').textContent=e.message}});</script>`;}

/**
 * 渲染公开首页（无需鉴权）：仅展示启用且同步成功的域名/IP 源卡片
 * 入参全部来自 D1，所有用户控制字段在模板内统一通过 escapeHtml 包裹
 */
export function getPublicHomepage(requestUrl, domains, ipSources, threeNetworkSourceName, loggedIn) {
    const origin = new URL(requestUrl).origin;
    const formatTime = (isoStr) => {
        if (!isoStr) return 'N/A';
        const date = new Date(isoStr);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const domainCards = domains.map(d => {
        let sourceHost;
        if (d.is_system) {
            sourceHost = threeNetworkSourceName;
        } else {
            try {
                let urlCompatibleSource = d.source_domain;
                if (!urlCompatibleSource.startsWith('http://') && !urlCompatibleSource.startsWith('https://')) {
                    urlCompatibleSource = 'https://' + urlCompatibleSource;
                }
                sourceHost = new URL(urlCompatibleSource).hostname;
            } catch (e) {
                sourceHost = d.source_domain || '解析错误';
            }
        }
        return `
        <div class="public-card" data-copy-content="${escapeHtml(d.target_domain)}">
            <div class="public-card-header">
                <h3 class="public-card-title">${escapeHtml(d.notes || '未知线路')}</h3>
                <span class="public-card-meta">${escapeHtml(formatTime(d.last_synced_time))}</span>
            </div>
            <div class="public-card-content">${escapeHtml(d.target_domain)}</div>
            <div class="public-card-footer">
                <i class="fa-solid fa-link fa-xs"></i> <span>来源: ${escapeHtml(sourceHost)}</span>
            </div>
        </div>`;
    }).join('');

    const ipSourceCards = ipSources.map(s => {
        const fullUrl = `${origin}/${s.github_path}`;
        return `
        <div class="public-card" data-copy-content="${escapeHtml(fullUrl)}">
            <div class="public-card-header">
                <h3 class="public-card-title">${escapeHtml(s.github_path)}</h3>
                <span class="public-card-meta">${escapeHtml(formatTime(s.last_synced_time))}</span>
            </div>
            <div class="public-card-content">${escapeHtml(fullUrl)}</div>
            <div class="public-card-footer">
                <i class="fa-solid fa-link fa-xs"></i> <span>来源: ${escapeHtml(new URL(s.url).hostname)}</span>
            </div>
        </div>`;
    }).join('');

    const authButton = loggedIn 
        ? `<a href="/admin" role="button">进入后台</a>`
        : `<button class="outline" onclick="document.getElementById('login-modal').showModal()">登录</button>`;

    return `
    <div class="public-body-wrapper">
        <div class="background-blurs">
            <div class="blur-orb blur-orb-1"></div>
            <div class="blur-orb blur-orb-2"></div>
        </div>
        <nav class="public-nav">
            <div class="public-nav-title">CF-DNS-Clon</div>
            <div class="public-nav-actions">
                ${authButton}
                <button id="theme-toggle" aria-label="Toggle theme">
                    <i class="fa-solid fa-moon"></i>
                </button>
            </div>
        </nav>
        <div class="public-container">
            <section class="public-section">
                <h2><i class="fa-solid fa-globe"></i> 优选域名</h2>
                <div class="public-grid">${domainCards || '<p>暂无可用数据</p>'}</div>
            </section>
            <section class="public-section">
                <h2><i class="fa-solid fa-server"></i> 优选API</h2>
                <div class="public-grid">${ipSourceCards || '<p>暂无可用数据</p>'}</div>
            </section>
        </div>
    </div>
    <div id="copy-toast" class="home-toast"></div>
    
    <dialog id="login-modal">
      <article>
        <header>
          <a href="#close" aria-label="Close" class="close" onclick="document.getElementById('login-modal').close()"></a>
          <h3>管理员登录</h3>
        </header>
        <p>请输入密码以继续。</p>
        <form id="modal-login-form">
          <label for="modal-password">密码</label>
          <input type="password" id="modal-password" name="password" required>
          <p id="modal-error-msg" style="color: var(--pico-color-red-500); height: 1em;"></p>
          <button type="submit">登录</button>
        </form>
      </article>
    </dialog>

    <script>
        const toast = document.getElementById('copy-toast');
        const themeToggle = document.getElementById('theme-toggle');
        const currentTheme = localStorage.getItem('theme');
        if (currentTheme) {
            document.documentElement.classList.add(currentTheme);
            if (currentTheme === 'dark') {
                themeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
            }
        }
        themeToggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
            let theme = 'light';
            if (document.documentElement.classList.contains('dark')) {
                theme = 'dark';
                themeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
            } else {
                 themeToggle.innerHTML = '<i class="fa-solid fa-moon"></i>';
            }
            localStorage.setItem('theme', theme);
        });

        function showToast(message) {
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
                toast.classList.add('hide');
                 setTimeout(() => toast.classList.remove('hide'), 400);
            }, 2000);
        }

        document.querySelector('.public-container').addEventListener('click', (event) => {
            const card = event.target.closest('.public-card');
            if (card && card.dataset.copyContent) {
                const content = card.dataset.copyContent;
                navigator.clipboard.writeText(content).then(() => {
                    showToast('已复制: ' + content);
                }, () => {
                    showToast('复制失败！');
                });
            }
        });
        
        document.getElementById('modal-login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('modal-password').value;
            const errorMsg = document.getElementById('modal-error-msg');
            const submitBtn = e.target.querySelector('button');
            errorMsg.textContent = '';
            submitBtn.setAttribute('aria-busy', 'true');
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || '登录失败');
                }
                window.location.href = '/admin';
            } catch (e) {
                errorMsg.textContent = e.message;
            } finally {
                submitBtn.removeAttribute('aria-busy');
            }
        });

    </script>
    `;
}
/**
 * 渲染已登录管理员的仪表盘页面骨架（含域名/IP 源表格 + 设置面板）
 * settings 必须是已过滤敏感字段的安全版本（getSafeSettings）
 */
export function getDashboardPage(domains, ipSources, settings) { 
    const githubSettingsComplete = settings.GITHUB_TOKEN && settings.GITHUB_OWNER && settings.GITHUB_REPO;
    return `<aside class="sidebar"><div class="sidebar-header"><h3>DNS Clone</h3></div><nav class="sidebar-nav"><a href="#page-dns-clone" class="nav-link active" data-target="page-dns-clone"><i class="fa-solid fa-clone fa-fw"></i> 域名克隆</a><a href="#page-github-upload" class="nav-link" data-target="page-github-upload"><i class="fa-brands fa-github fa-fw"></i> GitHub 上传</a><a href="#page-settings" class="nav-link" data-target="page-settings"><i class="fa-solid fa-gear fa-fw"></i> 系统设置</a></nav></aside>
    <div class="main-content">
        <div id="page-dns-clone" class="page active">
            <div class="page-header"><h2>域名克隆列表</h2><button id="addDomainBtn" ${settings.CF_ZONE_ID ? '' : 'disabled'}>＋ 添加克隆目标</button></div>
            <div id="domain-list-container"></div>
            <article><h3>手动操作</h3><p>点击下方按钮，可以立即为所有已启用的目标执行一次同步任务。</p><button id="manualSyncBtn">手动同步所有目标</button><pre id="logOutput" style="display:none;"></pre></article>
        </div>
        <div id="page-github-upload" class="page">
            <div class="page-header"><h2>GitHub IP源列表</h2><button id="addIpSourceBtn" ${githubSettingsComplete ? '' : 'disabled'}>＋ 添加IP源</button></div>
             <div id="ip-source-list-container"></div>
            <article><h3>手动操作</h3><p>点击下方按钮，可以立即为所有已启用的IP源执行一次同步并上传到GitHub。</p><button id="manualSyncIpSourcesBtn">同步所有IP源</button><pre id="ipLogOutput" style="display:none;"></pre></article>
        </div>
        <div id="page-settings" class="page">
            <div class="page-header"><h2>系统设置</h2></div>
            <form id="settingsForm">
                <fieldset><legend><i class="fa-brands fa-cloudflare"></i> Cloudflare API 设置</legend><label for="cfToken">API 令牌 (Token)</label><input type="password" id="cfToken" value="${settings.CF_API_TOKEN||''}"><label for="cfZoneId">区域 (Zone) ID</label><input type="text" id="cfZoneId" value="${settings.CF_ZONE_ID||''}">
                    <details class="tutorial-details"><summary>如何获取 API 令牌和区域 ID？</summary><div class="tutorial-content"><ol><li><strong>获取 API 令牌 (Token):</strong><ol type="a"><li>登录 <a href="https://dash.cloudflare.com/" target="_blank">Cloudflare</a>，进入 <strong>“我的个人资料”</strong> &rarr; <strong>“API 令牌”</strong>。</li><li>点击 <strong>“创建令牌”</strong>，然后选择 <strong>“编辑区域 DNS”</strong> 模板并点击“使用模板”。</li><li>在 <strong>“区域资源”</strong> 部分，选择您需要操作的具体域名区域。</li><li>点击“继续以显示摘要”和“创建令牌”，复制生成的令牌。<strong>注意：令牌仅显示一次，请妥善保管。</strong></li></ol></li><li><strong>获取区域 ID (Zone ID):</strong><ol type="a"><li>在 Cloudflare 仪表板主页，点击您需要操作的域名。</li><li>在域名的“概述”页面，您可以在右下角找到 <strong>“区域 ID”</strong>，点击即可复制。</li></ol></li></ol></div></details>
                </fieldset>
                 <fieldset><legend><i class="fa-solid fa-network-wired"></i> 三网优选IP源设置</legend><label for="threeNetworkSource">三网采集源</label><select id="threeNetworkSource"><option value="CloudFlareYes" ${settings.THREE_NETWORK_SOURCE === 'CloudFlareYes' ? 'selected' : ''}>CloudFlareYes</option><option value="api.uouin.com" ${settings.THREE_NETWORK_SOURCE === 'api.uouin.com' ? 'selected' : ''}>api.uouin.com</option><option value="wetest.vip" ${settings.THREE_NETWORK_SOURCE === 'wetest.vip' ? 'selected' : ''}>wetest.vip</option></select><small>为系统预设的电信/移动/联通域名选择IP来源。更改后保存设置将自动同步一次系统域名。</small>
                </fieldset>
                <fieldset><legend><i class="fa-brands fa-github"></i> GitHub API 设置</legend><label for="githubToken">GitHub Token</label><input type="password" id="githubToken" value="${settings.GITHUB_TOKEN||''}" placeholder="具有 repo 权限的 Personal Access Token"><label for="githubOwner">GitHub 用户名/组织名</label><input type="text" id="githubOwner" value="${settings.GITHUB_OWNER||''}" placeholder="例如: my-username"><label for="githubRepo">仓库名称</label><input type="text" id="githubRepo" value="${settings.GITHUB_REPO||''}" placeholder="例如: my-dns-records">
                    <details class="tutorial-details"><summary>如何获取 GitHub API 信息？</summary><div class="tutorial-content"><ol><li><strong>获取 GitHub Token:</strong><ol type="a"><li>登录 <a href="https://github.com/" target="_blank">GitHub</a>，点击右上角头像，进入 <strong>“Settings”</strong>。</li><li>在左侧菜单中，选择 <strong>“Developer settings”</strong> &rarr; <strong>“Personal access tokens”</strong> &rarr; <strong>“Tokens (classic)”</strong>。</li><li>点击 <strong>“Generate new token”</strong>，并选择 <strong>“Generate new token (classic)”</strong>。</li><li>为令牌添加描述（Note），设置合适的过期时间（Expiration）。</li><li>在 <strong>“Select scopes”</strong> 部分，勾选 <code>repo</code> 权限。</li><li>点击页面底部的 <strong>“Generate token”</strong>，并复制生成的令牌。<strong>注意：令牌仅显示一次，请妥善保管。</strong></li></ol></li><li><strong>获取用户名/组织名 和 仓库名称:</strong><ol type="a"><li><strong>用户名/组织名</strong> 就是您的GitHub个人主页URL中，github.com后面的那部分，或者您组织的主页URL。</li><li><strong>仓库名称</strong> 是您在GitHub上创建的，用来存储IP文件的仓库的名字。如果仓库不存在，系统将在第一次同步时自动为您创建为私有仓库。</li></ol></li></ol></div></details>
                </fieldset>
                <button type="submit">保存设置</button>
            </form>
        </div>
    </div>
    <dialog id="domainModal"><article><header><a href="#close" aria-label="Close" class="close" onclick="window.closeModal('domainModal')"></a><h3 id="modalTitle"></h3></header><form id="domainForm"><input type="hidden" id="domainId"><label for="source_domain">克隆域名</label><input type="text" id="source_domain" placeholder="example-source.com" required><label for="target_domain_prefix">我的域名前缀</label><div class="grid"><input type="text" id="target_domain_prefix" placeholder="subdomain or @" required><span id="zoneNameSuffix" style="line-height:var(--pico-form-element-height);font-weight:700">.your-zone.com</span></div><div class="grid"><div><label for="is_deep_resolve">深度 <span class="tooltip">(?)<span class="tooltip-text">开启后，如果克隆域名是CNAME，系统将递归查找最终的IP地址进行解析。关闭则直接克隆CNAME记录本身。</span></span></label><input type="checkbox" id="is_deep_resolve" role="switch" checked></div><div><label for="ttl">TTL (秒)</label><input type="number" id="ttl" min="60" max="86400" value="60" required></div></div><label for="notes">备注 (可选)</label><textarea id="notes" rows="2" placeholder="例如：主力CDN"></textarea><footer><button type="button" class="secondary" onclick="window.closeModal('domainModal')">取消</button><button type="submit" id="saveBtn">保存</button></footer></form></article></dialog>
    <dialog id="ipSourceModal"><article><header><a href="#close" aria-label="Close" class="close" onclick="window.closeModal('ipSourceModal')"></a><h3 id="ipSourceModalTitle"></h3></header><form id="ipSourceForm"><input type="hidden" id="ipSourceId"><div class="grid"><label for="ip_source_url">IP源地址</label><button type="button" class="outline" id="probeBtn" style="width:auto;padding:0 1rem;">探测方案</button></div><input type="text" id="ip_source_url" placeholder="https://example.com/ip_list.txt" required><progress id="probeProgress" style="display:none;"></progress><p id="probeResult" style="font-size:0.9em;"></p><label for="github_path">GitHub 文件路径</label><input type="text" id="github_path" placeholder="IP/Cloudflare.txt" required><label for="commit_message">Commit 信息</label><input type="text" id="commit_message" placeholder="Update Cloudflare IPs" required><footer><button type="button" class="secondary" onclick="window.closeModal('ipSourceModal')">取消</button><button type="submit" id="saveIpSourceBtn">保存</button></footer></form></article></dialog>
    <script>${getDashboardScript(domains, ipSources, settings)}</script>`;
}
/**
 * 渲染仪表盘浏览器端脚本（API 调用 / 流式同步 / 主题切换等）
 * 模板字符串中的 settings 仅渲染为可读视图，敏感字段已被剔除
 */
function getDashboardScript(domains, ipSources, settings) { return `
  function showNotification(message, type = 'info', duration = 5000) {
      const container = document.getElementById('notifications');
      const toast = document.createElement('div');
      toast.className = \`toast toast-\${type}\`;
      toast.innerHTML = \`<div>\${message}</div>\`;
      container.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
          toast.classList.add('hide');
          toast.addEventListener('transitionend', e => {
              if (e.target === toast) toast.remove();
          }, { once: true });
      }, duration);
  }
  async function apiFetch(url, options = {}) { const res = await fetch(url, { headers: { "Content-Type": "application/json", ...options.headers }, ...options }); if (!res.ok) { const errData = await res.json().catch(() => ({ error: \`HTTP 错误: \${res.status}\` })); if (res.status === 401) { showNotification('会话已过期，请重新登录。', 'error'); setTimeout(() => window.location.href = '/login', 2000); } throw new Error(errData.error); } try { return await res.json(); } catch (e) { return {}; } }
  let currentDomains = ${JSON.stringify(domains)};
  let currentIpSources = ${JSON.stringify(ipSources)};
  let currentSettings = ${JSON.stringify(settings)};
  let zoneName = currentSettings.zoneName || '';
  let successfulProbeStrategy = null;

  const formatBeijingTime = (isoStr) => { if (!isoStr) return '从未'; const d = new Date(isoStr); return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d).replace(/\\//g, '-'); };
  
  function renderLiveRecords(records) {
      if (!records || records.length === 0) return '无记录';
      const first = records[0];
      if (records.length === 1) return \`<b>\${first.type}:</b> \${first.content}\`;
      return \`<details class="record-details"><summary><b>\${first.type}:</b> (共 \${records.length} 条)</summary><ul>\${records.map(r => \`<li><b>\${r.type}:</b> \${r.content}</li>\`).join('')}</ul></details>\`;
  }
  
  function renderStatus(item) { switch (item.last_sync_status) { case 'success': return \`<span class="status-success">✔ 同步成功</span>\`; case 'failed': return \`<span class="status-failed" title="\${item.last_sync_error || '未知错误'}">✖ 同步失败</span>\`; case 'no_change': return \`<span class="status-no_change">✔ 内容一致</span>\`; default: return '○ 待定'; } }
  
  function renderDomainCard(domain) {
      let prefix = domain.target_domain;
      if (zoneName && domain.target_domain.endsWith('.' + zoneName)) {
          prefix = domain.target_domain.substring(0, domain.target_domain.length - (zoneName.length + 1));
      } else if (zoneName && domain.target_domain === zoneName) {
          prefix = '@';
      }
      const displayContent = domain.notes ? \`<strong>\${domain.notes}</strong>\` : \`<span class="domain-cell" title="\${domain.target_domain}">\${prefix}</span>\`;
      const isSystem = domain.is_system;
      const systemClass = isSystem ? 'system-domain' : '';
      const sourceDisplay = isSystem ? '系统内置' : domain.source_domain;

      return \`
      <div class="domain-card \${systemClass}" id="domain-card-\${domain.id}">
          <div class="card-col"><strong>我的域名 → 克隆源</strong><span class="domain-cell" title="\${domain.target_domain}" onclick="window.copyToClipboard('\${domain.target_domain}')">\${displayContent}</span><small class="domain-cell" title="\${domain.source_domain}">\${sourceDisplay}</small></div>
          <div class="card-col"><strong>当前解析</strong><div class="records-placeholder" data-domain-id="\${domain.id}"><i class="fa-solid fa-spinner fa-spin"></i> 正在查询...</div></div>
          <div class="card-col"><strong>上次同步</strong><div>\${renderStatus(domain)}</div><small>\${formatBeijingTime(domain.last_synced_time)}</small></div>
          <div class="card-actions"><button class="outline" onclick="window.individualSync(\${domain.id})">同步</button><button class="secondary outline" onclick="window.openModal('domainModal', \${domain.id})" \${isSystem ? 'disabled' : ''}>编辑</button><button class="contrast outline" onclick="window.deleteDomain(\${domain.id})" \${isSystem ? 'disabled' : ''}>删除</button></div>
      </div>\`;
  }
  function renderDomainList() { 
      const container = document.getElementById('domain-list-container');
      if (currentDomains.length > 0) {
        container.innerHTML = currentDomains.map(renderDomainCard).join(''); 
      } else {
        container.innerHTML = '<div class="empty-state"><p>暂无域名克隆目标，请点击右上角按钮添加。</p></div>';
      }
  }

   function renderIpSourceCard(source) {
      const fileUrl = \`\${window.location.origin}/\${source.github_path}\`;
      return \`
      <div class="domain-card" id="ip-source-card-\${source.id}">
           <div class="card-col" style="flex-grow: 2;"><strong>GitHub 文件路径</strong><a href="\${fileUrl}" target="_blank" class="domain-cell" onclick="event.stopPropagation();">\${source.github_path}</a><small class="domain-cell" title="\${source.url}">源: \${source.url}</small></div>
           <div class="card-col"><strong>抓取策略</strong><span>\${source.fetch_strategy || '尚未探测'}</span></div>
          <div class="card-col"><strong>上次同步</strong><small>\${renderStatus(source)} @ \${formatBeijingTime(source.last_synced_time)}</small></div>
          <div class="card-actions"><button class="outline" onclick="window.syncSingleIpSource(\${source.id})">同步</button><button class="secondary outline" onclick="window.openModal('ipSourceModal', \${source.id})">编辑</button><button class="contrast outline" onclick="window.deleteIpSource(\${source.id})">删除</button></div>
      </div>\`;
  }
  function renderIpSourceList() { 
      const container = document.getElementById('ip-source-list-container');
      if (currentIpSources.length > 0) {
        container.innerHTML = currentIpSources.map(renderIpSourceCard).join('');
      } else {
        container.innerHTML = '<div class="empty-state"><p>暂无IP源，请点击右上角按钮添加。</p></div>';
      }
  }

  window.copyToClipboard = (text) => { navigator.clipboard.writeText(text).then(() => { showNotification(\`已复制: \${text}\`, 'success', 3000); }, () => { showNotification(\`复制失败，请检查浏览器权限。\`, 'error'); }); };
  
  window.openModal = (modalId, id = null) => {
      const modal = document.getElementById(modalId);
      if (modalId === 'domainModal') {
          const form = document.getElementById('domainForm'); form.reset();
          document.getElementById('modalTitle').textContent = id ? '编辑克隆目标' : '添加新克隆目标';
          document.getElementById('zoneNameSuffix').textContent = zoneName ? '.' + zoneName : '(请先保存设置)';
          document.getElementById('is_deep_resolve').checked = true;
          if (id) {
              const domain = currentDomains.find(d => d.id === id);
              document.getElementById('domainId').value = domain.id;
              let prefix = domain.target_domain;
              if (zoneName) {
                  const suffix = '.' + zoneName;
                  if (domain.target_domain === zoneName) {
                      prefix = '@';
                  } else if (domain.target_domain.endsWith(suffix)) {
                      prefix = domain.target_domain.substring(0, domain.target_domain.length - suffix.length);
                  }
              }
              document.getElementById('target_domain_prefix').value = prefix;
              document.getElementById('source_domain').value = domain.source_domain;
              document.getElementById('is_deep_resolve').checked = !!domain.is_deep_resolve;
              document.getElementById('ttl').value = domain.ttl;
              document.getElementById('notes').value = domain.notes;
          } else { document.getElementById('domainId').value = ''; }
      } else if (modalId === 'ipSourceModal') {
          const form = document.getElementById('ipSourceForm'); form.reset();
          successfulProbeStrategy = null;
          document.getElementById('probeProgress').style.display = 'none';
          document.getElementById('probeResult').textContent = '';
          document.getElementById('saveIpSourceBtn').disabled = true;
          document.getElementById('probeBtn').disabled = false;
          document.getElementById('ipSourceModalTitle').textContent = id ? '编辑IP源' : '添加新IP源';
          if (id) {
              const source = currentIpSources.find(s => s.id === id);
              document.getElementById('ipSourceId').value = source.id;
              document.getElementById('ip_source_url').value = source.url;
              document.getElementById('github_path').value = source.github_path;
              document.getElementById('commit_message').value = source.commit_message;
              if (source.fetch_strategy) {
                  successfulProbeStrategy = source.fetch_strategy;
                  document.getElementById('probeResult').textContent = \`已缓存策略: \${successfulProbeStrategy}\`;
                  document.getElementById('saveIpSourceBtn').disabled = false;
              }
          } else {
              document.getElementById('ipSourceId').value = '';
          }
      }
      modal.showModal();
  };
  window.closeModal = (modalId) => { document.getElementById(modalId).close(); };

  async function saveDomain() {
      const id = document.getElementById('domainId').value;
      const payload = { source_domain: document.getElementById('source_domain').value, target_domain_prefix: document.getElementById('target_domain_prefix').value.trim(), is_deep_resolve: document.getElementById('is_deep_resolve').checked, ttl: parseInt(document.getElementById('ttl').value), notes: document.getElementById('notes').value };
      const url = id ? '/api/domains/' + id : '/api/domains'; const method = id ? 'PUT' : 'POST';
      try { const result = await apiFetch(url, { method, body: JSON.stringify(payload) }); showNotification(result.message, 'success'); closeModal('domainModal'); await refreshDomains(); } catch (e) { showNotification(\`保存失败: <code>\${e.message}</code>\`, 'error'); }
  }
  window.deleteDomain = async (id) => { if (!confirm('确定要删除这个目标吗？此操作不可逆转。')) return; try { const result = await apiFetch('/api/domains/' + id, { method: 'DELETE' }); showNotification(result.message, 'success'); await refreshDomains(); } catch (e) { showNotification(\`错误: <code>\${e.message}</code>\`, 'error'); } }
  
  async function refreshDomains() {
    try {
        currentDomains = await apiFetch('/api/domains');
        renderDomainList();
        fetchLiveRecords();
    } catch (e) {
        showNotification(\`更新列表失败: <code>\${e.message}</code>\`, 'error');
    }
  }
  
  async function fetchLiveRecords() {
    const placeholders = document.querySelectorAll('.records-placeholder');
    for (const el of placeholders) {
        const id = el.dataset.domainId;
        try {
            const records = await apiFetch('/api/domains/' + id + '/records');
            el.innerHTML = renderLiveRecords(records);
        } catch(e) {
            el.innerHTML = '<span class="status-failed">查询失败</span>';
        }
    }
  }

  async function saveIpSource() {
      const id = document.getElementById('ipSourceId').value;
      const payload = { url: document.getElementById('ip_source_url').value, github_path: document.getElementById('github_path').value, commit_message: document.getElementById('commit_message').value, fetch_strategy: successfulProbeStrategy };
      const apiUrl = id ? \`/api/ip_sources/\${id}\` : '/api/ip_sources';
      const method = id ? 'PUT' : 'POST';
      try { const result = await apiFetch(apiUrl, { method, body: JSON.stringify(payload) }); showNotification(result.message, 'success'); closeModal('ipSourceModal'); await refreshIpSources(); } catch (e) { showNotification(\`保存失败: <code>\${e.message}</code>\`, 'error'); }
  }
    window.deleteIpSource = async (id) => { if (!confirm('确定要删除这个IP源吗？')) return; try { await apiFetch(\`/api/ip_sources/\${id}\`, { method: 'DELETE' }); showNotification('IP源已删除', 'success'); await refreshIpSources(); } catch(e) { showNotification(\`删除失败: code>\${e.message}</code>\`, 'error'); } }
    async function refreshIpSources() { try { currentIpSources = await apiFetch('/api/ip_sources'); renderIpSourceList(); } catch (e) { showNotification(\`更新IP源列表失败: <code>\${e.message}</code>\`, 'error'); } }

  async function handleStreamingRequest(url, btn, logOutputElem) {
      const allButtons = document.querySelectorAll('button'); allButtons.forEach(b => b.disabled = true); const originalBtnText = btn ? btn.textContent : ''; if (btn) { btn.innerHTML = \`<i class="fa-solid fa-spinner fa-spin"></i> 同步中\`; btn.setAttribute('aria-busy', 'true'); }
      logOutputElem.style.display = 'block';
      logOutputElem.textContent = '开始同步任务...\\n';
      try { 
          const response = await fetch(url, { method: 'POST' });
          if (!response.ok || !response.body) throw new Error(\`服务器错误: \${response.status}\`);
          const reader = response.body.getReader(); 
          const decoder = new TextDecoder();
          while (true) { 
              const { done, value } = await reader.read(); 
              if (done) break; 
              const chunk = decoder.decode(value, { stream: true }); 
              const lines = chunk.split('\\n\\n').filter(line => line.startsWith('data: ')); 
              for (const line of lines) { logOutputElem.textContent += line.substring(6) + '\\n'; logOutputElem.scrollTop = logOutputElem.scrollHeight; } 
          }
          logOutputElem.textContent += '\\n同步完成，正在更新列表。';
          if(logOutputElem.id === 'logOutput') await refreshDomains();
          if(logOutputElem.id === 'ipLogOutput') await refreshIpSources();
      } catch (e) { 
          logOutputElem.textContent += '\\n发生严重错误：\\n' + e.message; 
          showNotification('同步任务发生错误', 'error');
      } finally { 
          allButtons.forEach(b => { if (!b.closest('dialog')) b.disabled = false; });
          if (btn) { btn.innerHTML = originalBtnText; btn.removeAttribute('aria-busy'); } 
      }
  }

  window.individualSync = (id) => {
      const btn = document.querySelector(\`#domain-card-\${id} .card-actions button:first-child\`);
      handleStreamingRequest(\`/api/domains/\${id}/sync\`, btn, document.getElementById('logOutput'));
  };
   window.syncSingleIpSource = (id) => {
      const btn = document.querySelector(\`#ip-source-card-\${id} .card-actions button:first-child\`);
      handleStreamingRequest(\`/api/ip_sources/\${id}/sync\`, btn, document.getElementById('ipLogOutput'));
  };

  async function saveSettings(event) {
      event.preventDefault();
      const btn = event.target.querySelector('button');
      btn.disabled = true; btn.setAttribute('aria-busy', 'true');
      
      const oldThreeNetworkSource = currentSettings.THREE_NETWORK_SOURCE;
      const newThreeNetworkSource = document.getElementById('threeNetworkSource').value;

      const settingsToSave = {
          CF_API_TOKEN: document.getElementById('cfToken').value,
          CF_ZONE_ID: document.getElementById('cfZoneId').value,
          THREE_NETWORK_SOURCE: newThreeNetworkSource,
          GITHUB_TOKEN: document.getElementById('githubToken').value,
          GITHUB_OWNER: document.getElementById('githubOwner').value,
          GITHUB_REPO: document.getElementById('githubRepo').value
      };
      try {
          const result = await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(settingsToSave) });
          showNotification(result.message || '设置已保存！', 'success');
          
          if (oldThreeNetworkSource !== newThreeNetworkSource) {
              showNotification('三网优选源已更改，正在为您同步系统域名...', 'info');
              handleStreamingRequest('/api/domains/sync_system', null, document.getElementById('logOutput'));
          }

          const newSettings = await apiFetch('/api/settings');
          currentSettings = {...currentSettings, ...newSettings };
          zoneName = currentSettings.zoneName || '';
          const githubSettingsComplete = currentSettings.GITHUB_TOKEN && currentSettings.GITHUB_OWNER && currentSettings.GITHUB_REPO;
          document.getElementById('addDomainBtn').disabled = !zoneName;
          document.getElementById('addIpSourceBtn').disabled = !githubSettingsComplete;
          await refreshDomains();
      } catch (e) {
          showNotification(\`保存失败: <br><code>\${e.message}</code>\`, 'error', 10000);
      } finally {
          btn.disabled = false; btn.removeAttribute('aria-busy');
      }
  }

  document.addEventListener('DOMContentLoaded', async () => {
      renderDomainList();
      renderIpSourceList();
      fetchLiveRecords();
      
      const navLinks = document.querySelectorAll('.nav-link');
      const pages = document.querySelectorAll('.page');
      navLinks.forEach(link => {
          link.addEventListener('click', (e) => {
              e.preventDefault();
              const targetId = link.dataset.target;
              pages.forEach(page => page.classList.remove('active'));
              document.getElementById(targetId).classList.add('active');
              navLinks.forEach(l => l.classList.remove('active'));
              link.classList.add('active');
          });
      });

      document.getElementById('settingsForm').addEventListener('submit', saveSettings);
      document.getElementById('addDomainBtn').addEventListener('click', () => openModal('domainModal'));
      document.getElementById('manualSyncBtn').addEventListener('click', (e) => handleStreamingRequest('/api/sync', e.target, document.getElementById('logOutput')));
      document.getElementById('domainForm').addEventListener('submit', (e) => { e.preventDefault(); saveDomain(); });

      document.getElementById('addIpSourceBtn').addEventListener('click', () => openModal('ipSourceModal'));
      document.getElementById('manualSyncIpSourcesBtn').addEventListener('click', (e) => handleStreamingRequest('/api/ip_sources/sync_all', e.target, document.getElementById('ipLogOutput')));
      document.getElementById('ipSourceForm').addEventListener('submit', (e) => { e.preventDefault(); saveIpSource(); });

      document.getElementById('probeBtn').addEventListener('click', async (e) => {
          const url = document.getElementById('ip_source_url').value;
          if (!url) { showNotification('请输入IP源地址', 'warning'); return; }
          
          const btn = e.target;
          const progress = document.getElementById('probeProgress');
          const resultElem = document.getElementById('probeResult');
          const saveBtn = document.getElementById('saveIpSourceBtn');

          btn.disabled = true;
          saveBtn.disabled = true;
          progress.style.display = 'block';
          progress.removeAttribute('value');
          resultElem.textContent = '正在探测...';
          successfulProbeStrategy = null;

          try {
              const result = await apiFetch('/api/ip_sources/probe', { method: 'POST', body: JSON.stringify({ url }) });
              progress.setAttribute('value', '100');
              resultElem.textContent = \`探测成功！策略: \${result.strategy} | 发现 \${result.ipCount} 个IP\`;
              successfulProbeStrategy = result.strategy;
              saveBtn.disabled = false;
          } catch (error) {
              progress.style.display = 'none';
              resultElem.textContent = \`探测失败: \${error.message}\`;
              showNotification(\`探测失败: \${error.message}\`, 'error');
          } finally {
              btn.disabled = false;
          }
      });
  });
`;}

// fetchThreeNetworkIps 已移至 ./sync/ip-sources.ts

