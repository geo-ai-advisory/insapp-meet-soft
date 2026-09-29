/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ['class'],
    content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
  	extend: {
  		fontFamily: {
  			// Manrope (next/font/google, кириллица) - шрифт интерфейса INmeet
  			sans: [
  				'var(--font-manrope)',
  				'system-ui',
  				'-apple-system',
  				'Segoe UI',
  				'sans-serif'
  			]
  		},
  		boxShadow: {
  			float: 'var(--im-float)'
  		},
  		colors: {
  			// Палитра главного экрана INmeet (эталон b-air): bg-im-bg, text-im-ink, bg-im-tone ...
  			im: {
  				bg: 'var(--im-bg)',
  				sheet: 'var(--im-sheet)',
  				ink: 'var(--im-ink)',
  				ink2: 'var(--im-ink2)',
  				mut: 'var(--im-mut)',
  				mut2: 'var(--im-mut2)',
  				mutbg: 'var(--im-mutbg)',
  				line: 'var(--im-line)',
  				line2: 'var(--im-line2)',
  				tone: 'var(--im-tone)',
  				'tone-h': 'var(--im-tone-h)',
  				'on-tone': 'var(--im-on-tone)',
  				'on-tone2': 'var(--im-on-tone2)',
  				butter: 'var(--im-butter)',
  				tray: 'var(--im-tray)',
  				'tray-h': 'var(--im-tray-h)',
  				panel: 'var(--im-panel)',
  				bub: 'var(--im-bub)',
  				data: 'var(--im-data)',
  				'data-t': 'var(--im-data-t)',
  				acc: 'var(--im-acc)',
  				'acc-h': 'var(--im-acc-h)',
  				hover: 'var(--im-hover)',
  				bullet: 'var(--im-bullet)',
  				rec: 'var(--im-rec)',
  				'rec-h': 'var(--im-rec-h)',
  				'rec-text': 'var(--im-rec-text)',
  				dotm: 'var(--im-dotm)'
  			},
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			tertiary: '#64748b',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}