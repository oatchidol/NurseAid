import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Add renderNavLinks before ui
render_nav_links = """function renderNavLinks(user, active) {
    if (!user) return { main: '', alerts: '' };
    const role = user.role;
    let main = '';
    let alerts = '';
    
    if (roleHasCapability(role, 'patients:read')) main += `<a href="/" title="Monitor" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'dash' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📊</span><span class="sidebar-hide">Monitor</span></a>\\n`;
    if (roleHasCapability(role, 'export:read')) main += `<a href="/export" title="Report" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'export' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📥</span><span class="sidebar-hide">Report</span></a>\\n`;
    
    if (roleHasCapability(role, 'devices:write')) main += `<a href="/devices-mgmt" title="Devices" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'devs' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📟</span><span class="sidebar-hide">Devices</span></a>\\n`;
    if (roleHasCapability(role, 'patients:write')) main += `<a href="/patients-mgmt" title="Patients" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'pats' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">👥</span><span class="sidebar-hide">Patients</span></a>\\n`;
    if (roleHasCapability(role, 'pairing:write')) main += `<a href="/matching" title="Pairing" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'match' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">⌚</span><span class="sidebar-hide">Pairing</span></a>\\n`;
    
    if (roleHasCapability(role, 'users:manage:ward') || roleHasCapability(role, 'users:manage:all')) main += `<a href="/users-mgmt" title="Users" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'users' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">🛡️</span><span class="sidebar-hide">Users</span></a>\\n`;

    alerts += `<a href="/notification-settings" title="Notification" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'notif' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📱</span><span class="sidebar-hide">Notification</span></a>\\n`;
    
    if (roleHasCapability(role, 'alerts:settings:write')) alerts += `<a href="/alert-settings" title="Alert Settings" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'alert' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">🔔</span><span class="sidebar-hide">Alert Settings</span></a>\\n`;
    if (roleHasCapability(role, 'alerts:read')) alerts += `<a href="/alert-history" title="Alert History" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'ahist' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📋</span><span class="sidebar-hide">Alert History</span></a>\\n`;
    
    if (roleHasCapability(role, 'wards:manage')) alerts += `<a href="/wards-mgmt" title="Wards" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'wards' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">🏥</span><span class="sidebar-hide">Wards</span></a>\\n`;
    if (roleHasCapability(role, 'audit:read:all') || roleHasCapability(role, 'audit:read:ward')) alerts += `<a href="/audit-log" title="Audit Log" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'audit' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📜</span><span class="sidebar-hide">Audit Log</span></a>\\n`;
    
    return { main, alerts };
}

function ui(active, content, script = "", user = null) {
    const navs = renderNavLinks(user, active);
    return `"""

content = content.replace('const ui = (active, content, script = "") => `', render_nav_links)

# 2. Update nav block inside ui template
old_nav_block = """<nav class="flex flex-col gap-1 flex-1">
            <a href="/" title="Monitor" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="patients:read" style="${active === 'dash' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📊</span><span class="sidebar-hide">Monitor</span>
            </a>

            <a href="/export" title="Report" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="export:read" style="${active === 'export' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📥</span><span class="sidebar-hide">Report</span>
            </a>

            <a href="/devices-mgmt" title="Devices" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="devices:write" style="${active === 'devs' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📟</span><span class="sidebar-hide">Devices</span>
            </a>

            <a href="/patients-mgmt" title="Patients" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="patients:write" style="${active === 'pats' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">👥</span><span class="sidebar-hide">Patients</span>
            </a>

            <a href="/matching" title="Pairing" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="pairing:write" style="${active === 'match' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">⌚</span><span class="sidebar-hide">Pairing</span>
            </a>

            <a href="/users-mgmt" title="Users" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="users:manage" style="${active === 'users' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">🛡️</span><span class="sidebar-hide">Users</span>
            </a>
        </nav>

        <div class="sidebar-hide mt-4 pt-4 border-t" style="border-color: var(--border-color);">
            <p class="text-[8px] font-bold uppercase tracking-widest mb-2 px-2" style="color: var(--text-tertiary);">Alerts</p>
            <a href="/notification-settings" title="Notification" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="alerts:settings:write" style="${active === 'notif' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📱</span><span class="sidebar-hide">Notification</span>
            </a>
            <a href="/alert-settings" title="Alert Settings" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="alerts:settings:write" style="${active === 'alert' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">🔔</span><span class="sidebar-hide">Alert Settings</span>
            </a>
            <a href="/alert-history" title="Alert History" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="alerts:read" style="${active === 'ahist' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📋</span><span class="sidebar-hide">Alert History</span>
            </a>
            <a href="/wards-mgmt" title="Wards" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="wards:manage" style="${active === 'wards' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">🏥</span><span class="sidebar-hide">Wards</span>
            </a>
            <a href="/audit-log" title="Audit Log" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" data-cap="audit:read" style="${active === 'audit' ? '' : 'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📜</span><span class="sidebar-hide">Audit Log</span>
            </a>
        </div>"""

new_nav_block = """<nav class="flex flex-col gap-1 flex-1">
            ${navs.main}
        </nav>

        <div class="sidebar-hide mt-4 pt-4 border-t" style="border-color: var(--border-color);">
            <p class="text-[8px] font-bold uppercase tracking-widest mb-2 px-2" style="color: var(--text-tertiary);">Alerts</p>
            ${navs.alerts}
        </div>"""

content = content.replace(old_nav_block, new_nav_block)

# 3. Add req.user to ui() calls in res.send(ui(...)) and res.status().send(ui(...))
# e.g., ui('dash', `...`, script) -> ui('dash', `...`, script, req.user)
# Wait, some ui calls might not have script argument.
# It's safer to use regex to find the matching brackets of ui(...) and append req.user.
# But regex matching nested brackets is hard.
# I will use a simple regex replacing end of ui call since almost all end with \`), or '`', ``)
# Let's write a small state machine to parse and append req.user
def add_req_user(text):
    idx = 0
    while True:
        idx = text.find('ui(', idx)
        if idx == -1:
            break
        # find matching closing parenthesis for ui(
        open_parens = 1
        j = idx + 3
        in_string = False
        string_char = ''
        in_template = False
        while j < len(text) and open_parens > 0:
            c = text[j]
            if not in_string and not in_template:
                if c == "'" or c == '"':
                    in_string = True
                    string_char = c
                elif c == '`':
                    in_template = True
                elif c == '(':
                    open_parens += 1
                elif c == ')':
                    open_parens -= 1
            elif in_string:
                if c == '\\': j += 1
                elif c == string_char:
                    in_string = False
            elif in_template:
                if c == '\\': j += 1
                elif c == '`':
                    in_template = False
            j += 1
        
        if open_parens == 0:
            # We found the closing parenthesis of ui()
            # It's at j-1. Let's insert ", req.user" before it.
            # But wait, ui definition itself starts with `function ui(`! We don't want to modify its definition.
            # And `ui('Access Denied'` in accessDeniedPage already has req.user. Let's make it robust by checking if it's already there or it's a definition.
            if "function ui(" in text[max(0, idx-9):idx+3]:
                idx = j
                continue
            if "const ui " in text[max(0, idx-9):idx+3]:
                idx = j
                continue
            args_str = text[idx+3:j-1]
            if 'req.user' not in args_str:
                text = text[:j-1] + ', req.user' + text[j-1:]
                j += 10 # adjust for added length
        idx = j
    return text

content = add_req_user(content)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated UI block and ui() calls")
