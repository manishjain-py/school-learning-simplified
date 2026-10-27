export function EarthArt({ small = false }: { small?: boolean }) {
  return <svg viewBox="0 0 440 380" className={small ? 'earth-art small' : 'earth-art'} role="img" aria-label="An illustrated Earth surrounded by little moments of discovery">
    <defs><clipPath id={small ? 'planet-small' : 'planet-large'}><circle cx="220" cy="185" r="106" /></clipPath></defs>
    <circle cx="220" cy="185" r="157" fill="none" stroke="#c0d7c3" strokeDasharray="4 10" />
    <ellipse cx="220" cy="301" rx="97" ry="11" fill="#c3d8be" opacity=".55" />
    <circle cx="220" cy="185" r="106" fill="#96c8cf" />
    <g clipPath={`url(#${small ? 'planet-small' : 'planet-large'})`} fill="#397b60">
      <path d="M125 132 143 113 166 114 176 126 192 130 188 148 167 155 163 172 144 184 124 178 112 156Z" />
      <path d="M157 181 178 177 196 193 201 214 187 239 183 260 172 272 161 247 162 222 147 206Z" />
      <path d="M238 94 263 100 272 116 292 118 315 139 310 160 285 161 278 183 258 190 248 174 226 169 221 148 238 135 228 118Z" />
      <path d="M238 176 258 181 278 210 269 234 249 251 239 225 228 201Z" />
      <path d="M291 234 316 231 328 247 311 263 286 257Z" />
    </g>
    <ellipse cx="220" cy="185" rx="54" ry="106" fill="none" stroke="#f4f5dc" strokeWidth="1.5" opacity=".5" />
    <ellipse cx="220" cy="185" rx="106" ry="42" fill="none" stroke="#f4f5dc" strokeWidth="1.5" opacity=".5" />
    <path d="M130 108 Q218 48 298 128" stroke="#fff" opacity=".25" strokeWidth="13" strokeLinecap="round" fill="none" />
    <path d="m67 112 4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="#d8a13e" />
    <path d="m359 237 4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="#d8a13e" />
    <circle cx="342" cy="83" r="9" fill="#edbc72" /><circle cx="91" cy="254" r="6" fill="#76a18a" />
    <path d="M340 169q34 1 34 21M88 199q-27-5-32 15" fill="none" stroke="#88ac93" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
