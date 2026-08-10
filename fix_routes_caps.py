import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

replacements = [
    ("app.get('/devices-mgmt', adminOnly,", "app.get('/devices-mgmt', requireCapability('devices:write'),"),
    ("app.post('/api/devices', adminOnly,", "app.post('/api/devices', requireCapability('devices:write'),"),
    ("app.post('/api/devices/update', adminOnly,", "app.post('/api/devices/update', requireCapability('devices:write'),"),
    ("app.delete('/api/devices/:mac', adminOnly,", "app.delete('/api/devices/:mac', requireCapability('devices:write'),"),
    
    ("app.get('/patients-mgmt', adminOnly,", "app.get('/patients-mgmt', requireCapability('patients:write'),"),
    ("app.post('/api/patients', adminOnly,", "app.post('/api/patients', requireCapability('patients:write'),"),
    ("app.post('/api/patients/update', adminOnly,", "app.post('/api/patients/update', requireCapability('patients:write'),"),
    ("app.delete('/api/patients/:hn', adminOnly,", "app.delete('/api/patients/:hn', requireCapability('patients:write'),"),
    
    ("app.get('/users-mgmt', adminOnly,", "app.get('/users-mgmt', requireCapability('users:manage:ward'),"),
    ("app.post('/api/users', adminOnly,", "app.post('/api/users', requireCapability('users:manage:ward'),"),
    ("app.put('/api/users/:id', adminOnly,", "app.put('/api/users/:id', requireCapability('users:manage:ward'),"),
    ("app.put('/api/users/:id/password', adminOnly,", "app.put('/api/users/:id/password', requireCapability('users:manage:ward'),"),
    ("app.delete('/api/users/:id', adminOnly,", "app.delete('/api/users/:id', requireCapability('users:manage:ward'),"),
    
    ("app.get('/matching', adminOnly,", "app.get('/matching', requireCapability('pairing:write'),"),
    ("app.post('/api/pair', adminOnly,", "app.post('/api/pair', requireCapability('pairing:write'),"),
    ("app.post('/api/unpair', adminOnly,", "app.post('/api/unpair', requireCapability('pairing:write'),"),
    ("app.post('/api/change-device', adminOnly,", "app.post('/api/change-device', requireCapability('pairing:write'),"),
    
    ("app.get('/api/devices-available', adminOnly,", "app.get('/api/devices-available', requireCapability('pairing:write'),"),
    
    ("app.get('/alert-settings', adminOnly,", "app.get('/alert-settings', requireCapability('alerts:settings:write'),"),
    ("app.post('/api/alert-settings', adminOnly,", "app.post('/api/alert-settings', requireCapability('alerts:settings:write'),"),
    ("app.delete('/api/alert-settings/:mac', adminOnly,", "app.delete('/api/alert-settings/:mac', requireCapability('alerts:settings:write'),"),
    
    ("app.get('/notification-settings', adminOnly,", "app.get('/notification-settings',"),
    ("app.post('/api/notification-settings', adminOnly,", "app.post('/api/notification-settings',"),
]

for old, new in replacements:
    content = content.replace(old, new)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated route capability middleware")
