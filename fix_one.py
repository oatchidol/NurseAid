import sys
with open('server.js', 'r') as f:
    lines = f.readlines()

line_idx = int(sys.argv[1]) - 1
lines[line_idx] = lines[line_idx].replace('`;', '\\`;')

with open('server.js', 'w') as f:
    f.writelines(lines)
