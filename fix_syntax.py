import re

with open('/root/nurseaid/server.js', 'r') as f:
    lines = f.readlines()

# fix line 983: "                `;" -> "                \`;"
lines[982] = lines[982].replace("                `;", "                \\`;")

# fix line 4452: "        const html = `" -> "        const html = \`"
lines[4451] = lines[4451].replace("        const html = `", "        const html = \\`")

with open('/root/nurseaid/server.js', 'w') as f:
    f.writelines(lines)

