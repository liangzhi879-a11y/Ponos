'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ponosRpc', {
  call: (method, params, id) => ipcRenderer.invoke('ponos:call', { method, params, id }),
  notify: (method, params) => ipcRenderer.send('ponos:notify', { method, params }),
  on: (method, cb) => {
    const h = (_event, env) => cb(env)
    ipcRenderer.on(`rpc:${method}`, h)
    return () => ipcRenderer.removeListener(`rpc:${method}`, h)
  },
  discover: () => ipcRenderer.invoke('ponos:call', { method: 'system.discover' }),
})
