// 仪表盘渲染助手（M-1）：把展示逻辑从模板串里提成可独立调用的工厂函数。
//
// 约束：createDashboardRenderers 的函数体会被 toString() 注入浏览器脚本，
// 因此它必须完全自包含——不 import、不引用模块作用域变量，所有依赖都从参数注入。
export function createDashboardRenderers({ escapeHtml, getZoneName, formatBeijingTime, origin }) {
    function renderLiveRecords(records) {
        if (!records || records.length === 0) return "无记录";
        const first = records[0];
        if (records.length === 1) return `<b>${escapeHtml(first.type)}:</b> ${escapeHtml(first.content)}`;
        return `<details class="record-details"><summary><b>${escapeHtml(first.type)}:</b> (共 ${records.length} 条)</summary><ul>${records.map((r) => `<li><b>${escapeHtml(r.type)}:</b> ${escapeHtml(r.content)}</li>`).join("")}</ul></details>`;
    }

    function renderStatus(item) {
        switch (item.last_sync_status) {
            case "success":
                return `<span class="status-success">✔ 同步成功</span>`;
            case "failed":
                return `<span class="status-failed" title="${escapeHtml(item.last_sync_error || "未知错误")}">✖ 同步失败</span>`;
            case "no_change":
                return `<span class="status-no_change">✔ 内容一致</span>`;
            default:
                return '<span class="status-pending">○ 待定</span>';
        }
    }

    function renderDomainCard(domain) {
        const zoneName = getZoneName();
        let prefix = domain.target_domain;
        if (zoneName && domain.target_domain.endsWith("." + zoneName)) {
            prefix = domain.target_domain.substring(0, domain.target_domain.length - (zoneName.length + 1));
        } else if (zoneName && domain.target_domain === zoneName) {
            prefix = "@";
        }
        const displayContent = domain.notes
            ? `<strong class="domain-notes">${escapeHtml(domain.notes)}</strong>`
            : `<span class="domain-cell" title="${escapeHtml(domain.target_domain)}">${escapeHtml(prefix)}</span>`;
        const isSystem = domain.is_system;
        const systemClass = isSystem ? "system-domain" : "";
        // 输入来源（issue #52）：系统内置 > URL 来源（展示完整 URL + 解析模式）> 域名
        const isUrlSource = !isSystem && domain.source_type === "url";
        const rawSourceUrl = typeof domain.source_url === "string" ? domain.source_url : "";
        // 解析模式只做白名单映射：未知值 / 存量 NULL 一律显示 auto，原始值不进入 HTML
        const parseModeLabels = { auto: "自动", lines: "按行", json_path: "JSON 路径", custom_regex: "自定义正则" };
        const rawParseMode = typeof domain.parse_mode === "string" ? domain.parse_mode.trim() : "";
        const parseModeLabel = Object.prototype.hasOwnProperty.call(parseModeLabels, rawParseMode)
            ? parseModeLabels[rawParseMode]
            : "自动";
        const sourceDisplay = isSystem ? "系统内置" : isUrlSource ? rawSourceUrl : domain.source_domain;
        const sourceTitle = isUrlSource ? rawSourceUrl : domain.source_domain;
        const sourceHint = isUrlSource ? `<small class="domain-cell">解析: ${escapeHtml(parseModeLabel)}</small>` : "";

        return `
      <div class="domain-card row-grid ${systemClass}" id="domain-card-${domain.id}">
          <div class="card-col"><span class="col-label">克隆目标</span><span class="domain-cell" title="${escapeHtml(domain.target_domain)}" data-target="${escapeHtml(domain.target_domain)}" onclick="window.copyToClipboard(this.dataset.target)">${displayContent}</span><small class="domain-cell" title="${escapeHtml(sourceTitle)}">${escapeHtml(sourceDisplay)}</small>${sourceHint}</div>
          <div class="card-col"><span class="col-label">当前解析</span><div class="records-placeholder" data-domain-id="${domain.id}"><i class="fa-solid fa-spinner fa-spin"></i> 正在查询...</div></div>
          <div class="card-col"><span class="col-label">上次同步</span><div>${renderStatus(domain)}</div><small>${formatBeijingTime(domain.last_synced_time)}</small></div>
          <div class="card-actions"><button class="outline" onclick="window.individualSync(${domain.id})">同步</button><button class="secondary outline" onclick="window.openModal('domainModal', ${domain.id})" ${isSystem ? "disabled" : ""}>编辑</button><button class="contrast outline" onclick="window.deleteDomain(${domain.id})" ${isSystem ? "disabled" : ""}>删除</button></div>
      </div>`;
    }

    function renderIpSourceCard(source) {
        // github_path 是 admin 可控值：URL 属性用 encodeURIComponent 阻断 scheme/属性逃逸，展示文本用 escapeHtml
        const fileUrl = `${origin}/${encodeURIComponent(source.github_path)}`;
        // 解析模式只做白名单映射：未知值 / 存量 NULL 一律显示 auto，原始值不进入 HTML（issue #50）
        const parseModeLabels = { auto: "自动", lines: "按行", json_path: "JSON 路径", custom_regex: "自定义正则" };
        const rawParseMode = typeof source.parse_mode === "string" ? source.parse_mode.trim() : "";
        const parseModeLabel = Object.prototype.hasOwnProperty.call(parseModeLabels, rawParseMode)
            ? parseModeLabels[rawParseMode]
            : "自动";
        return `
      <div class="domain-card row-grid" id="ip-source-card-${source.id}">
           <div class="card-col"><span class="col-label">GitHub 文件路径</span><a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener" class="domain-cell" onclick="event.stopPropagation();">${escapeHtml(source.github_path)}</a><small class="domain-cell" title="${escapeHtml(source.url)}">源: ${escapeHtml(source.url)}</small></div>
           <div class="card-col"><span class="col-label">抓取策略</span><span>${escapeHtml(source.fetch_strategy || "尚未探测")}</span><small class="domain-cell">解析: ${escapeHtml(parseModeLabel)}</small></div>
          <div class="card-col"><span class="col-label">上次同步</span><div>${renderStatus(source)}</div><small>${formatBeijingTime(source.last_synced_time)}</small></div>
          <div class="card-actions"><button class="outline" onclick="window.syncSingleIpSource(${source.id})">同步</button><button class="secondary outline" onclick="window.openModal('ipSourceModal', ${source.id})">编辑</button><button class="contrast outline" onclick="window.deleteIpSource(${source.id})">删除</button></div>
      </div>`;
    }

    return { renderLiveRecords, renderStatus, renderDomainCard, renderIpSourceCard };
}
