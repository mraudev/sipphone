'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phone', {
  getState: () => ipcRenderer.invoke('phone:state'),
  command: (msg) => ipcRenderer.invoke('phone:command', msg),
  sendAudio: (pcm) => ipcRenderer.send('phone:audio', pcm),
  getAudio: () => ipcRenderer.invoke('phone:getAudio'),
  setAudio: (audio) => ipcRenderer.invoke('phone:setAudio', audio),
  getAccount: () => ipcRenderer.invoke('phone:getAccount'),
  saveAccount: (data) => ipcRenderer.invoke('phone:saveAccount', data),
  getRingtone: () => ipcRenderer.invoke('phone:getRingtone'),
  chooseRingtone: () => ipcRenderer.invoke('phone:chooseRingtone'),
  resetRingtone: () => ipcRenderer.invoke('phone:resetRingtone'),
  getVersion: () => ipcRenderer.invoke('phone:version'),
  getUpdate: () => ipcRenderer.invoke('phone:getUpdate'),
  installUpdate: () => ipcRenderer.invoke('phone:installUpdate'),
  onUpdate: (cb) => ipcRenderer.on('phone:update', (_e, version) => cb(version)),
  getHistory: () => ipcRenderer.invoke('phone:history'),
  clearHistory: () => ipcRenderer.invoke('phone:clearHistory'),
  onHistory: (cb) => ipcRenderer.on('phone:historyChanged', (_e, entries) => cb(entries)),
  onShowHistory: (cb) => ipcRenderer.on('phone:showHistory', () => cb()),
  onState: (cb) => ipcRenderer.on('phone:state', (_e, s) => cb(s)),
  onEnded: (cb) => ipcRenderer.on('phone:ended', (_e, reason) => cb(reason)),
  onAudio: (cb) => ipcRenderer.on('phone:audio', (_e, pcm) => cb(pcm)),
});
