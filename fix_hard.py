with open('server.js', 'r') as f:
    lines = f.readlines()

# Line 4730
lines[4729] = '                </div>\\`;\n'

# Line 4799
lines[4798] = '        \\`;\n'

# Line 4973
lines[4972] = '            \\`;\n'

# Line 5032
lines[5031] = '        \\`;\n'

# Line 5123
lines[5122] = '                \\`;\n'

# Line 5369
lines[5368] = '            \\`;\n'

# Line 5950
lines[5949] = '            \\`;\n'

# Line 6038
lines[6037] = '            \\`;\n'

# Line 6683
lines[6682] = '            \\`;\n'

with open('server.js', 'w') as f:
    f.writelines(lines)
