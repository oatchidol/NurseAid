import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

old_sidebar = """        <div class="sidebar-hide mb-4 p-3 rounded-xl text-xs" style="background: var(--bg-sidebar-info); border: 1px solid var(--border-color);">
            <p id="display-nurse" class="font-bold truncate" style="color: var(--text-primary);">Checking...</p>
            <p id="display-role" class="text-[8px] font-bold uppercase" style="color: var(--text-tertiary);"></p>
        </div>"""

new_sidebar = """        <div class="sidebar-hide mb-4 p-3 rounded-xl text-xs" style="background: var(--bg-sidebar-info); border: 1px solid var(--border-color);">
            <p id="display-nurse" class="font-bold truncate" style="color: var(--text-primary);">Checking...</p>
            <p id="display-role" class="text-[8px] font-bold uppercase" style="color: var(--text-tertiary);"></p>
            <p id="display-ward" class="text-[9px] font-bold mt-1" style="color: var(--text-secondary);"></p>
        </div>"""

content = content.replace(old_sidebar, new_sidebar)

# update display-ward in script
old_script = """            document.getElementById('display-nurse').innerText = name || username || 'NurseAid';
            document.getElementById('display-role').innerText = _roleLabel(role);
            if (role === 'admin') document.body.classList.add('is-admin');"""

new_script = """            document.getElementById('display-nurse').innerText = name || username || 'NurseAid';
            document.getElementById('display-role').innerText = _roleLabel(role);
            
            // Sync capabilities to client classes
            document.body.classList.remove('is-admin'); // legacy
            if (data.capabilities) {
                data.capabilities.forEach(cap => {
                    document.body.classList.add('cap-' + cap.replace(/:/g, '-'));
                });
            }
            if (role === 'super_admin' || role === 'ward_admin') document.body.classList.add('is-admin');

            const wardEl = document.getElementById('display-ward');
            if (wardEl && data.wards && data.wards.length > 0) {
                wardEl.innerText = 'Wards: ' + data.wards.join(', ');
            } else if (wardEl) {
                wardEl.innerText = role === 'super_admin' ? 'All Wards' : 'No Ward Assigned';
            }"""

content = content.replace(old_script, new_script)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated sidebar user-info and api sync")
