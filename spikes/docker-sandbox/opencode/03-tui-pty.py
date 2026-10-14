#!/usr/bin/env python3
"""Exp 3 (automated half): drive `docker run -it` under a pty: size, resize, colors, input, Ctrl-C."""
import os, pty, sys, time, select, struct, fcntl, termios, re, signal
which = sys.argv[1]  # opencode1 | opencode2
auth = os.path.expanduser('~/.local/share/opencode/auth.json')
cmd = ['docker','run','--rm','-it','-e','TERM=xterm-256color','-e','COLORTERM=truecolor',
       '-v','oc-data:/home/node/.local/share/opencode','-v',f'{auth}:/home/node/.local/share/opencode/auth.json:ro',
       'oc-spike', which] + (['--standalone'] if which=='opencode2' else [])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
def setsize(r,c): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r,c,0,0))
def pump(t):
    buf=b''; end=time.time()+t
    while time.time()<end:
        if select.select([fd],[],[],0.2)[0]:
            try: d=os.read(fd,65536)
            except OSError: break
            if not d: break
            buf+=d
    return buf
setsize(30,100); out=pump(8)
txt=re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]',b'',out).decode('utf8','replace')
print('colors(38;2 truecolor/38;5 256):', b'\x1b[38;2' in out, b'\x1b[38;5' in out)
print('rendered bytes:', len(out)); print('has brand/prompt text:', bool(re.search(r'(?i)ask anything|opencode|build', txt)))
setsize(40,140); os.kill(pid, 0); os.killpg(os.getpgid(pid), signal.SIGWINCH) if False else None
out2=pump(3); print('bytes after resize (redraw):', len(out2))
os.write(fd,b'hello'); out3=pump(2); print('echo of typed input:', b'hello' in out3 or b'h' in out3, len(out3))
os.write(fd,b'\x03'); out4=pump(3)
try:
    p,st=os.waitpid(pid, os.WNOHANG); print('after ^C waitpid:',p,st)
except ChildProcessError: print('exited')
os.write(fd,b'\x04'); pump(2)
try: os.kill(pid,15)
except OSError: pass
