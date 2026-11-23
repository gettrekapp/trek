// The wildlife as pixels (campsite part 3d-2): each species on its own grid, facing right (the
// client flips it), in two frames: a walker's stride, a flier's wingbeat, a swimmer's bob. Drawn at
// the hikers' scale (3×). Each sprite is rows of cells, one letter a colour ('.' none), so the art
// reads as what it draws; the second frame replaces some rows of the first. Pure.
import type { Rect } from './pixels.ts'

/** At camp, 3× the grid, as the hikers and the dog */
export const ANIMAL_SCALE = 3

interface Art {
  /** A letter → its colour */
  colors: Readonly<Record<string, string>>
  /** Frame 0, top row first; every row as wide */
  rows: readonly string[]
  /** Frame 1: rows of frame 0 replaced (by their index) */
  frame1: Readonly<Record<number, string>>
}

// Shared tones, as the hikers' and the dog's: no outlines, a darker shade for the far side
const HOOF = '#1e1a18'
const EYE = '#111111'
const ANTLER = '#d6c49c'
const WHITE = '#ece6da'

const ART: Readonly<Record<string, Art>> = {
  deer: {
    colors: { C: '#8c7058', S: '#6e5642', B: '#cbb79c', W: WHITE, K: HOOF, A: ANTLER, E: '#7a604a' },
    rows: [
      '.............A...A..',
      '.............AA.AA..',
      '..............AAA...',
      '...........EEECCC...',
      '............ECCKCCC.',
      '.............CCCBBBK',
      '..............CC....',
      '..WSSSSSSSSSSSCC....',
      '.KWCCCCCCCCCCCCC....',
      '..WCCCCCCCCCCCCB....',
      '...CCCCCCCCCCCCB....',
      '....BBBBBBBBBBB.....',
      '....S.S.....S.S.....',
      '....S.S.....S.S.....',
      '....S.S.....S.S.....',
      '....K.K.....K.K.....'
    ],
    frame1: {
      12: '....SS......SS......',
      13: '....SS......SS......',
      14: '...S..S....S..S.....',
      15: '...K..K....K..K.....'
    }
  },
  fox: {
    colors: { O: '#d0702c', T: '#b85e22', W: WHITE, K: '#2a2020' },
    rows: [
      '..........K.K..',
      '..........OOKO.',
      '..........OOWWK',
      'TTT.OOOOOOOOW..',
      'WTTOOOOOOOOOW..',
      '.T..OOOOOOOO...',
      '....K.K...K.K..',
      '....K.K...K.K..'
    ],
    frame1: {
      3: '.TT.OOOOOOOOW..',
      4: 'WTTOOOOOOOOOW..',
      6: '....KK....KK...',
      7: '...K..K..K..K..'
    }
  },
  rabbit: {
    colors: { H: '#9a8468', E: '#8a7458', K: EYE, P: '#d89a9a', W: WHITE },
    rows: [
      '.....K.K..',
      '.....E.E..',
      '.....E.E..',
      '......EE..',
      '.....HHKH.',
      '..HHHHHHHP',
      '.HHHHHHH..',
      'WHHHHHHH..',
      '.HHHHHHH..',
      '.WW...WW..'
    ],
    frame1: {
      7: 'WHHHHHHH..',
      8: '..HHHHH...',
      9: 'WW.....WW.'
    }
  },
  squirrel: {
    colors: { R: '#b0582c', D: '#8a4020', W: '#e8d8c0', K: EYE },
    rows: [
      '.RR.......',
      'RRRR......',
      'RR.....D..',
      'RR....RRKR',
      '.RR.RRRRRR',
      '..RRRRRW..',
      '...RRRRW..',
      '...D..D...'
    ],
    frame1: {
      0: 'RR........',
      1: 'RRR.......',
      2: 'RRR....D..',
      7: '....DD....'
    }
  },
  chipmunk: {
    colors: { C: '#9a6a3c', D: '#3a2a1e', W: '#e8d8b8', H: '#a87a4a', K: EYE, P: '#5a3a28', B: '#d8c0a0' },
    rows: [
      'C........',
      'C.....HH.',
      '.CDDDDHKH',
      '.CWWWWHHP',
      '.CCCCCB..',
      '..P..P...'
    ],
    frame1: {
      0: '.C.......',
      1: 'C.....HH.',
      5: '...PP....'
    }
  },
  raccoon: {
    colors: { G: '#8a8a90', D: '#5a5a62', K: '#1e1e22', W: '#e0e0e4' },
    rows: [
      '..........G.G',
      '.......GGGGGG',
      '.....GGGGGKKK',
      '...GGGGGGGWWK',
      'KDKDGGGGGGG..',
      '...GGGGGGGG..',
      '...D.D..D.D..',
      '...K.K..K.K..'
    ],
    frame1: {
      4: 'DKDKGGGGGGG..',
      6: '....DD...DD..',
      7: '...K..K.K..K.'
    }
  },
  skunk: {
    colors: { K: '#302c36', W: WHITE },
    rows: [
      '.WW..........',
      'KWWK.........',
      'KKWKWWWWWW...',
      '.KKKKKKKKKWKK',
      '..KKKKKKKKKKK',
      '...KKKKKKKK..',
      '...K.K..K.K..'
    ],
    frame1: {
      0: 'WW...........',
      1: 'KWWK.........',
      6: '....KK..KK...'
    }
  },
  porcupine: {
    colors: { P: '#4a3a2c', Q: '#c8b89a', F: '#6a5440', K: EYE },
    rows: [
      '...Q.Q.Q....',
      '..QPQPQPQ...',
      '.QPPPPPPPQ..',
      'QPPPPPPPPPF.',
      'PPPPPPPPPFKF',
      '.PPPPPPPPFFF',
      '..PPPPPPP...',
      '..F.F..F.F..'
    ],
    frame1: {
      7: '...FF...FF..'
    }
  },
  marmot: {
    colors: { M: '#a0784a', D: '#6a4a2a', W: '#d8c4a0', K: EYE },
    rows: [
      '...........',
      '........MM.',
      '.......MMKM',
      '..MMMMMMMWW',
      'DMMMMMMMMM.',
      'DMMMMMMMMM.',
      '.MMMMMMMM..',
      '..D.D.D.D..'
    ],
    frame1: {
      7: '...DD..DD..'
    }
  },
  bear: {
    colors: { K: '#38343f', H: '#4e4958', S: '#2a2730', M: '#8a6a48', E: '#b0aab8' },
    rows: [
      '......................',
      '........HHHHH.........',
      '.....HHHKKKKHHH.......',
      '...HHKKKKKKKKKKKH.H.H.',
      '..HKKKKKKKKKKKKKKHKHK.',
      '..KKKKKKKKKKKKKKKKKEKM',
      '..KKKKKKKKKKKKKKKKKKMM',
      '..KKKKKKKKKKKKKKKK....',
      '...KKKKKKKKKKKKKKK....',
      '...SSS.KKKKKK.SSS.....',
      '...SSS........SSS.....',
      '...SSS........SSS.....',
      '...SSS........SSS.....',
      '..SSSS.......SSSS.....'
    ],
    frame1: {
      9: '....SSS.KKKK.SSS......',
      10: '....SSS.....SSS.......',
      11: '...SSS.......SSS......',
      12: '..SSS.........SSS.....',
      13: '.SSSS.........SSSS....'
    }
  },
  elk: {
    colors: { C: '#a48a64', N: '#4e3a2a', P: '#d8c8a8', S: '#6e5a40', K: HOOF, A: ANTLER },
    rows: [
      '..........A.A.........',
      '...........A.A.A......',
      '............A.AA.A....',
      '.............A.AAA....',
      '................NNNNN.',
      '...............NNNKNNK',
      '...............NNN..NN',
      '...............NNN....',
      '..PPCCCCCCCCCCCNNN....',
      '..PPCCCCCCCCCCCCNN....',
      '..PPCCCCCCCCCCCCC.....',
      '...PCCCCCCCCCCCCC.....',
      '....SSSSSSSSSSSS......',
      '....S.S.......S.S.....',
      '....S.S.......S.S.....',
      '....S.S.......S.S.....',
      '....K.K.......K.K.....'
    ],
    frame1: {
      13: '....SS........SS......',
      14: '....SS........SS......',
      15: '...S..S......S..S.....',
      16: '...K..K......K..K.....'
    }
  },
  owl: {
    colors: { O: '#8a6a48', D: '#5a4430', L: '#c8b090', Y: '#f0c040', K: EYE },
    rows: [
      '....D...D..',
      '....OOOOO..',
      '....OYKYO..',
      'DD..OOLOO..',
      'DOOOOLLLOOD',
      '.DOOOLLLOD.',
      '....OLLLO..',
      '.....OOO...',
      '.....D.D...'
    ],
    frame1: {
      3: '....OOLOO..',
      4: '...OOLLLOO.',
      5: '..DOOLLLOOD',
      6: '.DD.OLLLO.D',
      7: '.....OOO...',
      8: '.....D.D...'
    }
  },
  bat: {
    colors: { B: '#6a5450', W: '#54423f', K: '#e8d8a0' },
    rows: [
      'W....B.B....W',
      'WW...BBB...WW',
      '.WWWWBKBWWWW.',
      '..WW.BBB.WW..',
      '......B......'
    ],
    frame1: {
      0: '.....B.B.....',
      1: '.....BBB.....',
      2: '..WWWBKBWWW..',
      3: '.WWW.BBB.WWW.',
      4: 'WW....B....WW'
    }
  },
  hawk: {
    colors: { H: '#8a5e3c', D: '#5e4030', L: '#e0d0b8', R: '#c0502a', Y: '#e8c040', K: EYE },
    rows: [
      '...DDD..........',
      '....DDDD........',
      '.....DDHH...HH..',
      'RRRHHHHHHHHHHKH.',
      'RRRLLLLLLLLHHHHY',
      '.R..LLLLLLL.....',
      '................',
      '................'
    ],
    frame1: {
      0: '................',
      1: '................',
      2: '............HH..',
      5: '.R..LLLDDHH.....',
      6: '.....DDDD.......',
      7: '....DDD.........'
    }
  },
  woodpecker: {
    colors: { K: '#34343c', W: '#e8e8ec', R: '#d83a30', G: '#9a9aa0' },
    rows: [
      '.....KK.....',
      '......KWK..R',
      '.......KW.RR',
      'KK...KKKKKKK',
      '.KKKKKKKKWWG',
      '...KKKKK....',
      '............',
      '............'
    ],
    frame1: {
      0: '............',
      1: '...........R',
      2: '..........RR',
      5: '...KKKKKW...',
      6: '.....KWK....',
      7: '....KK......'
    }
  },
  heron: {
    colors: { G: '#7a8898', D: '#4a5462', W: '#d8dce4', Y: '#d8a840', K: EYE, L: '#5a5a48' },
    rows: [
      '.....DD.....',
      '......GGG...',
      '......GKGYYY',
      '......WGG...',
      '......WG....',
      '.....WG.....',
      '....WGG.....',
      '..GGGGGG....',
      '.DGGGGGGG...',
      'DDGGGGGGG...',
      '..DDGGGG....',
      '....L.L.....',
      '....L.L.....',
      '....L.L.....',
      '....L.L.....',
      '...L...L....'
    ],
    frame1: {
      1: '......GGG...',
      2: '......GKGYYY',
      14: '....L.L.....',
      15: '....L.L.....'
    }
  },
  duck: {
    colors: { G: '#2e7a4a', W: WHITE, B: '#8a7a6a', D: '#5a4a3e', Y: '#e0b040', K: EYE, P: '#6a5aa8' },
    rows: [
      '......GG..',
      '.....GGKG.',
      '......GGYY',
      '......WW..',
      'D.BBBBBBB.',
      'DDBBPPBBBB',
      '.DDDDDDDD.'
    ],
    frame1: {
      0: '..........',
      1: '......GG..',
      2: '.....GGKG.',
      3: '......GGYY',
      4: 'D.BBBBWWB.',
      5: 'DDBBPPBBBB',
      6: '.DDDDDDDD.'
    }
  },
  beaver: {
    colors: { B: '#6a4a2e', D: '#4a3220', T: '#3a3036', K: EYE, W: '#e8e0c8' },
    rows: [
      '......BBB...',
      '....BBBBBKB.',
      'TT.BBBBBBBBW',
      'TTTDDDDDDD..'
    ],
    frame1: {
      0: '.....BBB....',
      1: '...BBBBBKB..',
      2: 'TTBBBBBBBBW.',
      3: '.TTDDDDDD...'
    }
  },
  otter: {
    colors: { O: '#5a4030', L: '#b09474', K: EYE },
    rows: [
      '..........OOO.',
      '..........OKOL',
      '...OOOOOOOOOLL',
      'OOO...........'
    ],
    frame1: {
      0: '..........OOO.',
      1: '..........OKOL',
      2: '..OOOOOOOOOOLL',
      3: '.OO...........'
    }
  },
  frog: {
    colors: { F: '#5aa040', D: '#3a7030', Y: '#e8d870', K: EYE },
    rows: [
      '..KF.KF.',
      '.FFFFFF.',
      'FFFYYFFF',
      'D.D..D.D'
    ],
    frame1: {
      0: '........',
      1: '..KF.KF.',
      2: '.FFFFFF.',
      3: 'DFFYYFFD'
    }
  },
  moose: {
    colors: { D: '#3e2e24', L: '#8a7a68', A: '#c8b48c', K: HOOF },
    rows: [
      '...............A......A.',
      '...............AA....AA.',
      '...............AAAAAAAA.',
      '..................DDDD..',
      '............DD...DDDDD..',
      '.........DDDDDDDDDDDDDD.',
      '....DDDDDDDDDDDDDDDDDDDD',
      '...DDDDDDDDDDDDDDDD..DDK',
      '..DDDDDDDDDDDDDDDD...DD.',
      '..DDDDDDDDDDDDDDDD......',
      '..DDDDDDDDDDDDDDDD......',
      '...DDDDDDDDDDDDDD.......',
      '....L.L.......L.L.......',
      '....L.L.......L.L.......',
      '....L.L.......L.L.......',
      '....L.L.......L.L.......',
      '....L.L.......L.L.......',
      '....K.K.......K.K.......'
    ],
    frame1: {
      12: '....LL........LL........',
      13: '....LL........LL........',
      14: '....LL........LL........',
      15: '...L..L......L..L.......',
      16: '...L..L......L..L.......',
      17: '...K..K......K..K.......'
    }
  },
  lynx: {
    colors: { L: '#a8987a', D: '#6a5c48', S: '#5a4e3e', W: '#e0d8c8', K: '#1e1a18' },
    rows: [
      '..........K..K',
      '..........L..L',
      '..........LLLL',
      '..........LKLL',
      'K.LLLLLLLLLWWD',
      'DLLDLLDLLLLWW.',
      '.LLLLLLLLLL...',
      '..LLLLLLLLL...',
      '..SS.....SS...',
      '..SS.....SS...',
      '..WW.....WW...'
    ],
    frame1: {
      8: '...SS...SS....',
      9: '..S..S.S..S...',
      10: '.WW..WWW..W...'
    }
  },
  wolf: {
    colors: { K: '#3a3840', H: '#56525e', S: '#2e2c34', Y: '#e0b840', G: '#8a8690' },
    rows: [
      '..............H.H.',
      '..............KKK.',
      '.............KKYKK',
      '...HHHHHHHHHHKKKKG',
      'HHKKKKKKKKKKKKK...',
      'K..KKKKKKKKKKKK...',
      '...KKKKKKKKKKK....',
      '...S.S.....S.S....',
      '...S.S.....S.S....',
      '...S.S.....S.S....',
      '...S.S.....S.S....'
    ],
    frame1: {
      7: '...SS......SS.....',
      8: '..S..S....S..S....',
      9: '.S....S..S....S...',
      10: '.S....S..S....S...'
    }
  },
  stag: {
    colors: { W: '#e8e8ee', S: '#c4c4d0', A: '#f0e4c0', K: '#5a5a66', E: '#d0d0dc' },
    rows: [
      '...........A.A.A.A..',
      '...........AAAAAA...',
      '............A.AA....',
      '...........EEEWWW...',
      '............EWWKWWW.',
      '.............WWWWWWK',
      '..............WW....',
      '..WSSSSSSSSSSSWW....',
      '..WWWWWWWWWWWWWW....',
      '..WWWWWWWWWWWWWW....',
      '...WWWWWWWWWWWWS....',
      '....SSSSSSSSSSS.....',
      '....S.S.....S.S.....',
      '....S.S.....S.S.....',
      '....S.S.....S.S.....',
      '....K.K.....K.K.....'
    ],
    frame1: {
      12: '....SS......SS......',
      13: '....SS......SS......',
      14: '...S..S....S..S.....',
      15: '...K..K....K..K.....'
    }
  }
}

/** The species this file draws (one entry per species in wildlife.ts's SPECIES) */
export const ANIMAL_IDS: readonly string[] = Object.keys(ART)

/** A species' grid (frame 0's; frame 1 is the same size) */
export function animalSize(id: string): { w: number; h: number } {
  const art = ART[id]
  return { w: art.rows[0].length, h: art.rows.length }
}

/** Whether this file draws a species */
export const hasArt = (id: string): boolean => Object.hasOwn(ART, id)

/** A frame's rows */
export function animalRows(id: string, frame: 0 | 1): string[] {
  const art = ART[id]
  return art.rows.map((row, y) => (frame === 1 && Object.hasOwn(art.frame1, y) ? art.frame1[y] : row))
}

/** A species' pixels in a frame: each row's runs of one letter as a rect */
export function animalPixels(id: string, frame: 0 | 1 = 0): Rect[] {
  const art = ART[id]
  const out: Rect[] = []
  animalRows(id, frame).forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]
      let end = x + 1
      while (end < row.length && row[end] === ch) end++
      if (ch !== '.') out.push({ x, y, w: end - x, h: 1, fill: art.colors[ch] })
      x = end
    }
  })
  return out
}
