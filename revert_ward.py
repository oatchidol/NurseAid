with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

content = content.replace("const html = `", "const html = \\`")
content = content.replace("${escapeHTML(code)}", "\\${escapeHTML(code)}")
content = content.replace("${escapeHTML(name)}", "\\${escapeHTML(name)}")
content = content.replace("${isActive ? 'selected' : ''}", "\\${isActive ? 'selected' : ''}")
content = content.replace("${!isActive ? 'selected' : ''}", "\\${!isActive ? 'selected' : ''}")
content = content.replace("            `;", "            \\`;")
content = content.replace("const opts = `${wardOpts}`;", "const opts = \\`${wardOpts}\\`;")
content = content.replace("${escapeHTML(username)}", "\\${escapeHTML(username)}")
content = content.replace("${escapeHTML(fullName)}", "\\${escapeHTML(fullName)}")
content = content.replace("${currentRole === 'viewer' ? 'selected' : ''}", "\\${currentRole === 'viewer' ? 'selected' : ''}")
content = content.replace("${currentRole === 'staff_nurse' || currentRole === 'operator' ? 'selected' : ''}", "\\${currentRole === 'staff_nurse' || currentRole === 'operator' ? 'selected' : ''}")
content = content.replace("${currentRole === 'ward_admin' ? 'selected' : ''}", "\\${currentRole === 'ward_admin' ? 'selected' : ''}")
content = content.replace("${currentRole === 'super_admin' || currentRole === 'admin' ? 'selected' : ''}", "\\${currentRole === 'super_admin' || currentRole === 'admin' ? 'selected' : ''}")
content = content.replace("${opts}", "\\${opts}")

# BUT wait! We should NOT replace const html = ` if it is NOT inside ui()!
# Let's write a smarter script.
