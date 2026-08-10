import re
with open('/root/nurseaid/server.js', 'r') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    # Fix the const html = ` to const html = \`
    if 'const html = `' in line:
        lines[i] = line.replace('const html = `', 'const html = \\`')
    
    # Fix the `            `;` to `            \`;` except line 4107 and 6571 which don't have it on a newline
    if '            `;' in line or '                `;' in line or '                </div>`;' in line or '        `;' in line:
        lines[i] = line.replace('`;', '\\`;')

    # Fix the `, \`` to `, ``
    if '`, \\`' in line:
        lines[i] = line.replace('`, \\`', '`, `')
        
    # Also I appended `\`;` manually to 983, let's make sure it doesn't become `\\`;`
    lines[i] = lines[i].replace('\\\\`;', '\\`;')

with open('/root/nurseaid/server.js', 'w') as f:
    f.writelines(lines)

