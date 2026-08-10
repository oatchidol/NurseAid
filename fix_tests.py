import re

with open('/root/nurseaid/test_dashboard_stability.js', 'r') as f:
    content = f.read()

content = content.replace("adminOnly", "requireCapability\\(")

with open('/root/nurseaid/test_dashboard_stability.js', 'w') as f:
    f.write(content)
print("Updated tests to use requireCapability")
