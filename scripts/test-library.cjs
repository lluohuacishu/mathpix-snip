const {spawn}=require('node:child_process');
const path=require('node:path');
const root=path.dirname(__dirname),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[path.join(root,'tests/library-runtime.cjs')],{cwd:root,env,windowsHide:true,stdio:'inherit'});
child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
