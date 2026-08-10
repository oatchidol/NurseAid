with open('server.js', 'r') as f:
    content = f.read()

with open('temp_routes.js', 'r') as f:
    routes = f.read()

content = content.replace("async function startServer() {", routes + "\nasync function startServer() {")

with open('server.js', 'w') as f:
    f.write(content)
print("Routes injected")
