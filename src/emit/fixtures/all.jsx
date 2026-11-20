// JSX round trip.
export function App({ items, ...props }) {
  return (
    <div className="app" {...props} data-x={1} disabled>
      {/* comment child */}
      <Header.Title text='hi' />
      <svg:circle r="1" />
      <>
        {items.map((item) => <Item key={item.id} {...item} />)}
      </>
      text &amp; more
      {cond ? <A /> : null}
    </div>
  )
}
const el = <a href={url}>link</a>
const led = <p title={/* attr */ 'x'}>{/* lead */ value}</p>
