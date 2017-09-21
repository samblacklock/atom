const _ = require('underscore-plus')
const {CompositeDisposable, Emitter} = require('event-kit')
const {Point, Range} = require('text-buffer')
const TokenizedLine = require('./tokenized-line')
const TokenIterator = require('./token-iterator')
const ScopeDescriptor = require('./scope-descriptor')
const TokenizedBufferIterator = require('./tokenized-buffer-iterator')
const NullGrammar = require('./null-grammar')
const {toFirstMateScopeId} = require('./first-mate-helpers')

let nextId = 0
const prefixedScopes = new Map()

module.exports =
class TokenizedBuffer {
  static deserialize (state, atomEnvironment) {
    const buffer = atomEnvironment.project.bufferForIdSync(state.bufferId)
    if (!buffer) return null

    state.buffer = buffer
    state.assert = atomEnvironment.assert
    return new TokenizedBuffer(state)
  }

  constructor (params) {
    this.emitter = new Emitter()
    this.disposables = new CompositeDisposable()
    this.tokenIterator = new TokenIterator(this)

    this.alive = true
    this.id = params.id != null ? params.id : nextId++
    this.buffer = params.buffer
    this.tabLength = params.tabLength
    this.largeFileMode = params.largeFileMode
    this.assert = params.assert

    this.setGrammar(params.grammar || NullGrammar)
    this.disposables.add(this.buffer.registerTextDecorationLayer(this))
  }

  destroy () {
    if (!this.alive) return
    this.alive = false
    this.disposables.dispose()
    this.tokenizedLines.length = 0
  }

  isAlive () {
    return this.alive
  }

  isDestroyed () {
    return !this.alive
  }

  buildIterator () {
    return new TokenizedBufferIterator(this)
  }

  classNameForScopeId (id) {
    const scope = this.grammar.scopeForId(toFirstMateScopeId(id))
    if (scope) {
      let prefixedScope = prefixedScopes.get(scope)
      if (prefixedScope) {
        return prefixedScope
      } else {
        prefixedScope = `syntax--${scope.replace(/\./g, ' syntax--')}`
        prefixedScopes.set(scope, prefixedScope)
        return prefixedScope
      }
    } else {
      return null
    }
  }

  getInvalidatedRanges () {
    return []
  }

  onDidInvalidateRange (fn) {
    return this.emitter.on('did-invalidate-range', fn)
  }

  serialize () {
    return {
      deserializer: 'TokenizedBuffer',
      bufferPath: this.buffer.getPath(),
      bufferId: this.buffer.getId(),
      tabLength: this.tabLength,
      largeFileMode: this.largeFileMode
    }
  }

  observeGrammar (callback) {
    callback(this.grammar)
    return this.onDidChangeGrammar(callback)
  }

  onDidChangeGrammar (callback) {
    return this.emitter.on('did-change-grammar', callback)
  }

  onDidTokenize (callback) {
    return this.emitter.on('did-tokenize', callback)
  }

  setGrammar (grammar) {
    if (!grammar || grammar === this.grammar) return

    this.grammar = grammar
    this.rootScopeDescriptor = new ScopeDescriptor({scopes: [this.grammar.scopeName]})

    if (this.grammarUpdateDisposable) this.grammarUpdateDisposable.dispose()
    this.grammarUpdateDisposable = this.grammar.onDidUpdate(() => this.retokenizeLines())
    this.disposables.add(this.grammarUpdateDisposable)

    this.retokenizeLines()
    this.emitter.emit('did-change-grammar', grammar)
  }

  getGrammarSelectionContent () {
    return this.buffer.getTextInRange([[0, 0], [10, 0]])
  }

  hasTokenForSelector (selector) {
    for (const tokenizedLine of this.tokenizedLines) {
      if (tokenizedLine) {
        for (let token of tokenizedLine.tokens) {
          if (selector.matches(token.scopes)) return true
        }
      }
    }
    return false
  }

  retokenizeLines () {
    if (!this.alive) return
    this.fullyTokenized = false
    this.tokenizedLines = new Array(this.buffer.getLineCount())
    this.invalidRows = []
    if (this.largeFileMode || this.grammar.name === 'Null Grammar') {
      this.markTokenizationComplete()
    } else {
      this.invalidateRow(0)
    }
  }

  setVisible (visible) {
    this.visible = visible
    if (this.visible && this.grammar.name !== 'Null Grammar' && !this.largeFileMode) {
      this.tokenizeInBackground()
    }
  }

  getTabLength () { return this.tabLength }

  setTabLength (tabLength) {
    this.tabLength = tabLength
  }

  tokenizeInBackground () {
    if (!this.visible || this.pendingChunk || !this.alive) return

    this.pendingChunk = true
    _.defer(() => {
      this.pendingChunk = false
      if (this.isAlive() && this.buffer.isAlive()) this.tokenizeNextChunk()
    })
  }

  tokenizeNextChunk () {
    let rowsRemaining = this.chunkSize

    while (this.firstInvalidRow() != null && rowsRemaining > 0) {
      var endRow, filledRegion
      const startRow = this.invalidRows.shift()
      const lastRow = this.getLastRow()
      if (startRow > lastRow) continue

      let row = startRow
      while (true) {
        const previousStack = this.stackForRow(row)
        this.tokenizedLines[row] = this.buildTokenizedLineForRow(row, this.stackForRow(row - 1), this.openScopesForRow(row))
        if (--rowsRemaining === 0) {
          filledRegion = false
          endRow = row
          break
        }
        if (row === lastRow || _.isEqual(this.stackForRow(row), previousStack)) {
          filledRegion = true
          endRow = row
          break
        }
        row++
      }

      this.validateRow(endRow)
      if (!filledRegion) this.invalidateRow(endRow + 1)

      this.emitter.emit('did-invalidate-range', Range(Point(startRow, 0), Point(endRow + 1, 0)))
    }

    if (this.firstInvalidRow() != null) {
      this.tokenizeInBackground()
    } else {
      this.markTokenizationComplete()
    }
  }

  markTokenizationComplete () {
    if (!this.fullyTokenized) {
      this.emitter.emit('did-tokenize')
    }
    this.fullyTokenized = true
  }

  firstInvalidRow () {
    return this.invalidRows[0]
  }

  validateRow (row) {
    while (this.invalidRows[0] <= row) this.invalidRows.shift()
  }

  invalidateRow (row) {
    this.invalidRows.push(row)
    this.invalidRows.sort((a, b) => a - b)
    this.tokenizeInBackground()
  }

  updateInvalidRows (start, end, delta) {
    this.invalidRows = this.invalidRows.map((row) => {
      if (row < start) {
        return row
      } else if (start <= row && row <= end) {
        return end + delta + 1
      } else if (row > end) {
        return row + delta
      }
    })
  }

  bufferDidChange (e) {
    this.changeCount = this.buffer.changeCount

    const {oldRange, newRange} = e
    const start = oldRange.start.row
    const end = oldRange.end.row
    const delta = newRange.end.row - oldRange.end.row
    const oldLineCount = (oldRange.end.row - oldRange.start.row) + 1
    const newLineCount = (newRange.end.row - newRange.start.row) + 1

    this.updateInvalidRows(start, end, delta)
    const previousEndStack = this.stackForRow(end) // used in spill detection below
    if (this.largeFileMode || (this.grammar.name === 'Null Grammar')) {
      _.spliceWithArray(this.tokenizedLines, start, oldLineCount, new Array(newLineCount))
    } else {
      const newTokenizedLines = this.buildTokenizedLinesForRows(start, end + delta, this.stackForRow(start - 1), this.openScopesForRow(start))
      _.spliceWithArray(this.tokenizedLines, start, oldLineCount, newTokenizedLines)
      const newEndStack = this.stackForRow(end + delta)
      if (newEndStack && !_.isEqual(newEndStack, previousEndStack)) {
        this.invalidateRow(end + delta + 1)
      }
    }
  }

  isFoldableAtRow (row) {
    return this.isFoldableCodeAtRow(row) || this.isFoldableCommentAtRow(row)
  }

  // Returns a {Boolean} indicating whether the given buffer row starts
  // a a foldable row range due to the code's indentation patterns.
  isFoldableCodeAtRow (row) {
    if (row >= 0 && row <= this.buffer.getLastRow()) {
      const nextRow = this.buffer.nextNonBlankRow(row)
      const tokenizedLine = this.tokenizedLines[row]
      if (this.buffer.isRowBlank(row) || (tokenizedLine && tokenizedLine.isComment()) || nextRow == null) {
        return false
      } else {
        return this.indentLevelForRow(nextRow) > this.indentLevelForRow(row)
      }
    } else {
      return false
    }
  }

  isFoldableCommentAtRow (row) {
    const previousRow = row - 1
    const nextRow = row + 1
    return (
      (!this.tokenizedLines[previousRow] || !this.tokenizedLines[previousRow].isComment()) &&
      (this.tokenizedLines[row] && this.tokenizedLines[row].isComment()) &&
      (this.tokenizedLines[nextRow] && this.tokenizedLines[nextRow].isComment())
    )
  }

  buildTokenizedLinesForRows (startRow, endRow, startingStack, startingopenScopes) {
    let ruleStack = startingStack
    let openScopes = startingopenScopes
    const stopTokenizingAt = startRow + this.chunkSize
    const tokenizedLines = []
    for (let row = startRow, end = endRow; row <= end; row++) {
      let tokenizedLine
      if ((ruleStack || (row === 0)) && row < stopTokenizingAt) {
        tokenizedLine = this.buildTokenizedLineForRow(row, ruleStack, openScopes)
        ruleStack = tokenizedLine.ruleStack
        openScopes = this.scopesFromTags(openScopes, tokenizedLine.tags)
      }
      tokenizedLines.push(tokenizedLine)
    }

    if (endRow >= stopTokenizingAt) {
      this.invalidateRow(stopTokenizingAt)
      this.tokenizeInBackground()
    }

    return tokenizedLines
  }

  buildTokenizedLineForRow (row, ruleStack, openScopes) {
    return this.buildTokenizedLineForRowWithText(row, this.buffer.lineForRow(row), ruleStack, openScopes)
  }

  buildTokenizedLineForRowWithText (row, text, currentRuleStack = this.stackForRow(row - 1), openScopes = this.openScopesForRow(row)) {
    const lineEnding = this.buffer.lineEndingForRow(row)
    const {tags, ruleStack} = this.grammar.tokenizeLine(text, currentRuleStack, row === 0, false)
    return new TokenizedLine({
      openScopes,
      text,
      tags,
      ruleStack,
      lineEnding,
      tokenIterator: this.tokenIterator,
      grammar: this.grammar
    })
  }

  tokenizedLineForRow (bufferRow) {
    if (bufferRow >= 0 && bufferRow <= this.buffer.getLastRow()) {
      const tokenizedLine = this.tokenizedLines[bufferRow]
      if (tokenizedLine) {
        return tokenizedLine
      } else {
        const text = this.buffer.lineForRow(bufferRow)
        const lineEnding = this.buffer.lineEndingForRow(bufferRow)
        const tags = [
          this.grammar.startIdForScope(this.grammar.scopeName),
          text.length,
          this.grammar.endIdForScope(this.grammar.scopeName)
        ]
        this.tokenizedLines[bufferRow] = new TokenizedLine({
          openScopes: [],
          text,
          tags,
          lineEnding,
          tokenIterator: this.tokenIterator,
          grammar: this.grammar
        })
        return this.tokenizedLines[bufferRow]
      }
    }
  }

  tokenizedLinesForRows (startRow, endRow) {
    const result = []
    for (let row = startRow, end = endRow; row <= end; row++) {
      result.push(this.tokenizedLineForRow(row))
    }
    return result
  }

  stackForRow (bufferRow) {
    return this.tokenizedLines[bufferRow] && this.tokenizedLines[bufferRow].ruleStack
  }

  openScopesForRow (bufferRow) {
    const precedingLine = this.tokenizedLines[bufferRow - 1]
    if (precedingLine) {
      return this.scopesFromTags(precedingLine.openScopes, precedingLine.tags)
    } else {
      return []
    }
  }

  scopesFromTags (startingScopes, tags) {
    const scopes = startingScopes.slice()
    for (const tag of tags) {
      if (tag < 0) {
        if (tag % 2 === -1) {
          scopes.push(tag)
        } else {
          const matchingStartTag = tag + 1
          while (true) {
            if (scopes.pop() === matchingStartTag) break
            if (scopes.length === 0) {
              this.assert(false, 'Encountered an unmatched scope end tag.', error => {
                error.metadata = {
                  grammarScopeName: this.grammar.scopeName,
                  unmatchedEndTag: this.grammar.scopeForId(tag)
                }
                const path = require('path')
                error.privateMetadataDescription = `The contents of \`${path.basename(this.buffer.getPath())}\``
                error.privateMetadata = {
                  filePath: this.buffer.getPath(),
                  fileContents: this.buffer.getText()
                }
              })
              break
            }
          }
        }
      }
    }
    return scopes
  }

  indentLevelForRow (bufferRow) {
    const line = this.buffer.lineForRow(bufferRow)
    let indentLevel = 0

    if (line === '') {
      let nextRow = bufferRow + 1
      const lineCount = this.getLineCount()
      while (nextRow < lineCount) {
        const nextLine = this.buffer.lineForRow(nextRow)
        if (nextLine !== '') {
          indentLevel = Math.ceil(this.indentLevelForLine(nextLine))
          break
        }
        nextRow++
      }

      let previousRow = bufferRow - 1
      while (previousRow >= 0) {
        const previousLine = this.buffer.lineForRow(previousRow)
        if (previousLine !== '') {
          indentLevel = Math.max(Math.ceil(this.indentLevelForLine(previousLine)), indentLevel)
          break
        }
        previousRow--
      }

      return indentLevel
    } else {
      return this.indentLevelForLine(line)
    }
  }

  indentLevelForLine (line, tabLength = this.tabLength) {
    let indentLength = 0
    for (let i = 0, {length} = line; i < length; i++) {
      const char = line[i]
      if (char === '\t') {
        indentLength += tabLength - (indentLength % tabLength)
      } else if (char === ' ') {
        indentLength++
      } else {
        break
      }
    }
    return indentLength / tabLength
  }

  scopeDescriptorForPosition (position) {
    let scopes
    const {row, column} = this.buffer.clipPosition(Point.fromObject(position))

    const iterator = this.tokenizedLineForRow(row).getTokenIterator()
    while (iterator.next()) {
      if (iterator.getBufferEnd() > column) {
        scopes = iterator.getScopes()
        break
      }
    }

    // rebuild scope of last token if we iterated off the end
    if (!scopes) {
      scopes = iterator.getScopes()
      scopes.push(...iterator.getScopeEnds().reverse())
    }

    return new ScopeDescriptor({scopes})
  }

  tokenForPosition (position) {
    const {row, column} = Point.fromObject(position)
    return this.tokenizedLineForRow(row).tokenAtBufferColumn(column)
  }

  tokenStartPositionForPosition (position) {
    let {row, column} = Point.fromObject(position)
    column = this.tokenizedLineForRow(row).tokenStartColumnForBufferColumn(column)
    return new Point(row, column)
  }

  bufferRangeForScopeAtPosition (selector, position) {
    let endColumn, tag, tokenIndex
    position = Point.fromObject(position)

    const {openScopes, tags} = this.tokenizedLineForRow(position.row)
    const scopes = openScopes.map(tag => this.grammar.scopeForId(tag))

    let startColumn = 0
    for (tokenIndex = 0; tokenIndex < tags.length; tokenIndex++) {
      tag = tags[tokenIndex]
      if (tag < 0) {
        if ((tag % 2) === -1) {
          scopes.push(this.grammar.scopeForId(tag))
        } else {
          scopes.pop()
        }
      } else {
        endColumn = startColumn + tag
        if (endColumn >= position.column) {
          break
        } else {
          startColumn = endColumn
        }
      }
    }

    if (!selectorMatchesAnyScope(selector, scopes)) return

    const startScopes = scopes.slice()
    for (let startTokenIndex = tokenIndex - 1; startTokenIndex >= 0; startTokenIndex--) {
      tag = tags[startTokenIndex]
      if (tag < 0) {
        if ((tag % 2) === -1) {
          startScopes.pop()
        } else {
          startScopes.push(this.grammar.scopeForId(tag))
        }
      } else {
        if (!selectorMatchesAnyScope(selector, startScopes)) { break }
        startColumn -= tag
      }
    }

    const endScopes = scopes.slice()
    for (let endTokenIndex = tokenIndex + 1, end = tags.length; endTokenIndex < end; endTokenIndex++) {
      tag = tags[endTokenIndex]
      if (tag < 0) {
        if ((tag % 2) === -1) {
          endScopes.push(this.grammar.scopeForId(tag))
        } else {
          endScopes.pop()
        }
      } else {
        if (!selectorMatchesAnyScope(selector, endScopes)) { break }
        endColumn += tag
      }
    }

    return new Range(new Point(position.row, startColumn), new Point(position.row, endColumn))
  }

  // Gets the row number of the last line.
  //
  // Returns a {Number}.
  getLastRow () {
    return this.buffer.getLastRow()
  }

  getLineCount () {
    return this.buffer.getLineCount()
  }

  logLines (start = 0, end = this.buffer.getLastRow()) {
    for (let row = start; row <= end; row++) {
      const line = this.tokenizedLines[row].text
      console.log(row, line, line.length)
    }
  }
}

function selectorMatchesAnyScope (selector, scopes) {
  const targetClasses = selector.replace(/^\./, '').split('.')
  return scopes.some((scope) => {
    const scopeClasses = scope.split('.')
    return _.isSubset(targetClasses, scopeClasses)
  })
}